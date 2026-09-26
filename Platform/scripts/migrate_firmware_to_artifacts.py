#!/usr/bin/env python3
"""One-off migration: DEVICE#/FIRMWARE# rows -> ARTIFACT# records (type=firmware).

For every legacy firmware row this writes, in one transaction:
  - ARTIFACT#{id} / METADATA            (the artifact, pointing at the existing S3 object)
  - USER#{owner} / ARTIFACT#{id}        + ARTIFACT#{id} / USER#{owner}
  - DEVICE#{did} / ARTIFACT#firmware#{id} + ARTIFACT#{id} / DEVICE#{did}
  - DEVICE#{did} / FWVER#{version}      (the firmware version guard)

The S3 objects are not moved, and the FIRMWARE# rows are left in place.
The guard row is written conditionally, so a firmware version that was
already migrated (or already uploaded again through artifacts) is skipped,
and the script is safe to run more than once.

Usage:
  python3 migrate_firmware_to_artifacts.py --table healthcare-iot-testbed-dev-metadata          # dry run
  python3 migrate_firmware_to_artifacts.py --table healthcare-iot-testbed-dev-metadata --apply
"""
import argparse
import secrets
import sys
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr, Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

serializer = TypeSerializer()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", required=True, help="Metadata table name")
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--profile", default=None, help="AWS CLI profile")
    parser.add_argument("--apply", action="store_true", help="Write the records (default is a dry run)")
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)
    client = session.client("dynamodb")

    counts = {"migrated": 0, "would_migrate": 0, "already_migrated": 0, "no_owner": 0}
    for row in _scan_firmware(table):
        device_id = row["pk"][len("DEVICE#"):]
        version = row["version"]
        label = f"device {device_id} firmware {version}"

        owner = _find_owner(table, device_id)
        if owner is None:
            print(f"SKIP  {label}: device has no owner")
            counts["no_owner"] += 1
            continue

        guard = table.get_item(Key={"pk": f"DEVICE#{device_id}", "sk": f"FWVER#{version}"}).get("Item")
        if guard is not None:
            print(f"SKIP  {label}: already migrated as artifact {guard.get('artifactId')}")
            counts["already_migrated"] += 1
            continue

        user_id, device_name = owner
        artifact_id = _uuid7_at(row.get("createdAt"))

        if not args.apply:
            print(f"PLAN  {label} -> artifact {artifact_id} (owner {user_id}, status {row['status']})")
            counts["would_migrate"] += 1
            continue

        try:
            client.transact_write_items(TransactItems=_transaction(args.table, row, artifact_id, user_id, device_id, device_name))
        except ClientError as e:
            if e.response["Error"]["Code"] == "TransactionCanceledException":
                print(f"SKIP  {label}: version was claimed while migrating")
                counts["already_migrated"] += 1
                continue
            raise
        print(f"DONE  {label} -> artifact {artifact_id}")
        counts["migrated"] += 1

    print()
    print(", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in counts.items()))
    if not args.apply:
        print("Dry run only. Re-run with --apply to write the records.")


def _scan_firmware(table):
    kwargs = {"FilterExpression": Attr("sk").begins_with("FIRMWARE#") & Attr("entity").eq("firmware")}
    while True:
        page = table.scan(**kwargs)
        yield from page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _find_owner(table, device_id):
    """Returns (userId, deviceName) for the device's owner, or None."""
    links = table.query(
        KeyConditionExpression=Key("pk").eq(f"DEVICE#{device_id}") & Key("sk").begins_with("USER#")
    ).get("Items", [])
    for link in links:
        if link.get("role") == "owner":
            user_id = link["sk"][len("USER#"):]
            user_link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"DEVICE#{device_id}"}).get("Item") or {}
            return user_id, user_link.get("name") or device_id
    return None


def _transaction(table_name, row, artifact_id, user_id, device_id, device_name):
    now = datetime.now(timezone.utc).isoformat()
    name = row.get("originalFilename") or f"firmware-{row['version']}.bin"
    created_at = row.get("createdAt") or now

    artifact = {
        "pk": f"ARTIFACT#{artifact_id}",
        "sk": "METADATA",
        "entity": "artifact",
        "artifactId": artifact_id,
        "name": name,
        "type": "firmware",
        "origin": "upload",
        "version": row["version"],
        "sha256": row["sha256"],
        "sizeBytes": row["sizeBytes"],
        "originalFilename": name,
        "s3Bucket": row["s3Bucket"],
        "s3Key": row["s3Key"],
        "attemptId": row["attemptId"],
        "uploadMode": "single",
        "status": row["status"],
        "statusUpdatedAt": row.get("updatedAt") or created_at,
        "deviceIds": {device_id},
        "migratedFromFirmwareId": row.get("firmwareId"),
        "createdBy": row.get("createdBy") or user_id,
        "createdAt": created_at,
        "updatedAt": now,
    }
    if row.get("uploadedAt"):
        artifact["uploadedAt"] = row["uploadedAt"]

    rows = [
        artifact,
        {"pk": f"USER#{user_id}", "sk": f"ARTIFACT#{artifact_id}", "entity": "user-artifact",
         "role": "owner", "name": name, "type": "firmware", "createdAt": created_at},
        {"pk": f"ARTIFACT#{artifact_id}", "sk": f"USER#{user_id}", "entity": "artifact-user", "role": "owner"},
        {"pk": f"DEVICE#{device_id}", "sk": f"ARTIFACT#firmware#{artifact_id}", "entity": "device-artifact",
         "name": name, "type": "firmware"},
        {"pk": f"ARTIFACT#{artifact_id}", "sk": f"DEVICE#{device_id}", "entity": "artifact-device", "name": device_name},
        {"pk": f"DEVICE#{device_id}", "sk": f"FWVER#{row['version']}", "entity": "device-firmware-version",
         "artifactId": artifact_id, "version": row["version"], "createdAt": now},
    ]
    return [
        {
            "Put": {
                "TableName": table_name,
                "Item": {k: serializer.serialize(v) for k, v in r.items() if v is not None},
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        }
        for r in rows
    ]


def _uuid7_at(iso_timestamp):
    # Same layout as artifacts-presign's _uuid7, but timed at the original
    # upload so migrated firmware sorts among artifacts by upload date.
    try:
        millis = int(datetime.fromisoformat(iso_timestamp).timestamp() * 1000)
    except (TypeError, ValueError):
        millis = int(datetime.now(timezone.utc).timestamp() * 1000)
    value = (millis & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


if __name__ == "__main__":
    sys.exit(main())
