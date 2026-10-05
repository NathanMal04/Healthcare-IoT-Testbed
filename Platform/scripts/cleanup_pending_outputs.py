#!/usr/bin/env python3
"""Removes run-output artifacts that never finished uploading.

When a job fails part-way through uploading its outputs, the output
artifacts it registered stay "pending" forever and show on the Artifacts
page. This deletes them: the ARTIFACT# record, its USER#/ARTIFACT# and
ARTIFACT#/USER# ownership rows, and the S3 object if one was written (the
bucket's lifecycle rule would remove that within a week anyway).

Only artifacts with origin = run and status = pending that are older than
--min-age-minutes are touched, so outputs of runs still in progress are
left alone. Uploaded files (origin = upload) are never touched.

  python3 cleanup_pending_outputs.py --table healthcare-iot-testbed-dev-metadata             # dry run
  python3 cleanup_pending_outputs.py --table healthcare-iot-testbed-dev-metadata --apply
  python3 cleanup_pending_outputs.py --table ... --run-id <runId> --apply                    # one run only
"""
import argparse
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", required=True, help="Metadata table name")
    parser.add_argument("--run-id", help="Only clean up outputs of this run")
    parser.add_argument("--user-id", help="Only clean up outputs owned by this user (Cognito sub)")
    parser.add_argument("--min-age-minutes", type=int, default=60,
                        help="Skip outputs registered more recently than this (default 60)")
    parser.add_argument("--apply", action="store_true", help="Delete (default is a dry run)")
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--profile")
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)
    s3 = session.client("s3")
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.min_age_minutes)

    condition = Attr("sk").eq("METADATA") & Attr("entity").eq("artifact") \
        & Attr("origin").eq("run") & Attr("status").eq("pending")
    if args.run_id:
        condition &= Attr("derivedFromRun").eq(args.run_id)
    if args.user_id:
        condition &= Attr("createdBy").eq(args.user_id)

    found = removed = skipped = 0
    for item in _scan(table, condition):
        found += 1
        artifact_id = item["artifactId"]
        label = f"{item.get('originalFilename')} (run {item.get('derivedFromRun')}, artifact {artifact_id})"
        try:
            created = datetime.fromisoformat(item.get("createdAt", ""))
        except ValueError:
            created = cutoff
        if created > cutoff:
            print(f"SKIP  {label}: registered less than {args.min_age_minutes} min ago")
            skipped += 1
            continue
        if not args.apply:
            print(f"PLAN  {label}")
            continue

        owner = item["createdBy"]
        with table.batch_writer() as writer:
            writer.delete_item(Key={"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"})
            writer.delete_item(Key={"pk": f"USER#{owner}", "sk": f"ARTIFACT#{artifact_id}"})
            writer.delete_item(Key={"pk": f"ARTIFACT#{artifact_id}", "sk": f"USER#{owner}"})
        try:
            s3.delete_object(Bucket=item["s3Bucket"], Key=item["s3Key"])
        except ClientError:
            pass  # nothing was uploaded, or no permission; the lifecycle rule covers it
        print(f"DONE  {label}")
        removed += 1

    print()
    if args.apply:
        print(f"found {found}, removed {removed}, skipped {skipped}")
    else:
        print(f"found {found}, would remove {found - skipped}, skipped {skipped}")
        print("Dry run only. Re-run with --apply to delete.")


def _scan(table, condition):
    kwargs = {"FilterExpression": condition}
    while True:
        page = table.scan(**kwargs)
        yield from page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


if __name__ == "__main__":
    main()
