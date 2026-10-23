#!/usr/bin/env python3
"""Records a published platform image as a new ready version of a platform
environment (platform-base or platform-ghidra).

Run by the deploy-images workflow after each push. Every user can build on
platform environments; script builds also copy /opt/platform (launcher +
SDK) from the newest platform-base version.

  python3 seed_platform_envs.py --table healthcare-iot-testbed-dev-metadata \\
      --env-id platform-base --image-uri <repo>@sha256:... \\
      [--packages-dir ./packages --bucket healthcare-iot-testbed-dev-data-lake]

Idempotent: if the newest ready version already has this image, nothing
changes.
"""
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3
from boto3.dynamodb.conditions import Key

DESCRIPTIONS = {
    "platform-base": ("Analysis base", "Python 3.12 with tshark, binwalk, scapy, dpkt, pyshark, lief, "
                      "pyelftools, capstone, yara-python, pandas and unblob"),
    "platform-ghidra": ("Analysis base + Ghidra", "The analysis base plus headless Ghidra 11.1 (analyzeHeadless)"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", required=True)
    parser.add_argument("--env-id", required=True, choices=sorted(DESCRIPTIONS))
    parser.add_argument("--image-uri", required=True, help="repository@sha256:digest")
    parser.add_argument("--packages-dir", type=Path, help="folder with pip-freeze.txt and dpkg.txt")
    parser.add_argument("--bucket", help="data lake bucket, for the package lists")
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--profile")
    args = parser.parse_args()
    if "@sha256:" not in args.image_uri:
        sys.exit("--image-uri must be a digest reference (repo@sha256:...)")

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)
    env_id = args.env_id
    name, description = DESCRIPTIONS[env_id]
    now = datetime.now(timezone.utc).isoformat()

    table.update_item(
        Key={"pk": f"ENV#{env_id}", "sk": "METADATA"},
        UpdateExpression=(
            "SET entity = :e, envId = :id, #n = :name, description = :d, createdBy = :p, "
            "createdAt = if_not_exists(createdAt, :now), updatedAt = :now, "
            "latestVersion = if_not_exists(latestVersion, :zero)"
        ),
        ExpressionAttributeNames={"#n": "name"},
        ExpressionAttributeValues={":e": "env", ":id": env_id, ":name": name, ":d": description,
                                   ":p": "platform", ":now": now, ":zero": 0},
    )
    table.put_item(Item={"pk": "PLATFORM", "sk": f"ENV#{env_id}", "entity": "platform-env"})

    versions = table.query(
        KeyConditionExpression=Key("pk").eq(f"ENV#{env_id}") & Key("sk").begins_with("VERSION#"),
        ScanIndexForward=False,
    ).get("Items", [])
    latest_ready = next((v for v in versions if v.get("status") == "ready"), None)
    if latest_ready and latest_ready.get("imageUri") == args.image_uri:
        print(f"{env_id} v{int(latest_ready['version'])} already has {args.image_uri}; nothing to do")
        return

    n = int(table.update_item(
        Key={"pk": f"ENV#{env_id}", "sk": "METADATA"},
        UpdateExpression="ADD latestVersion :one",
        ExpressionAttributeValues={":one": 1},
        ReturnValues="UPDATED_NEW",
    )["Attributes"]["latestVersion"])

    freeze_key = f"builds/envs/{env_id}/{n}/"
    if args.packages_dir and args.bucket:
        s3 = session.client("s3")
        for name_ in ("pip-freeze.txt", "dpkg.txt"):
            path = args.packages_dir / name_
            if path.exists():
                s3.upload_file(str(path), args.bucket, freeze_key + name_)

    table.put_item(Item={
        "pk": f"ENV#{env_id}", "sk": f"VERSION#{n:04d}", "entity": "env-version", "envId": env_id,
        "version": n, "imageUri": args.image_uri, "catalogItems": [], "packageMode": "offline",
        "status": "ready", "statusUpdatedAt": now, "createdBy": "platform", "createdAt": now,
        "freezeKey": freeze_key,
    }, ConditionExpression="attribute_not_exists(pk)")
    table.update_item(
        Key={"pk": f"ENV#{env_id}", "sk": "METADATA"},
        UpdateExpression="SET latestReadyVersion = :n",
        ExpressionAttributeValues={":n": n},
    )
    print(f"{env_id} v{n} -> {args.image_uri}")


if __name__ == "__main__":
    main()
