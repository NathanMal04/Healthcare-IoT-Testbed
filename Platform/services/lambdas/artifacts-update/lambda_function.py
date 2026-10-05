import json
import os
import re
import boto3
import testbed_authz
from datetime import datetime, timezone
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

# reverseEngineeringStatus is reverse-engineering progress on a firmware
# artifact. It is separate from the upload lifecycle "status"
# (pending/verifying/ready/failed), which this endpoint never touches.
RE_STATUSES = ("not_started", "in_progress", "complete")
UPDATABLE_FIELDS = {"reverseEngineeringStatus"}

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def handler(event, context):
    """PATCH /artifacts/{artifactId} with {"reverseEngineeringStatus": ...}."""
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    artifact_id = (event.get("pathParameters") or {}).get("artifactId")
    if not isinstance(artifact_id, str) or not UUID_PATTERN.match(artifact_id):
        return _resp(400, {"error": "artifactId is invalid or missing"})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON in request body"})

    if not isinstance(body, dict):
        return _resp(400, {"error": "Invalid JSON in request body"})

    table = dynamodb.Table(TABLE)

    # Same ownership rule as the other artifact endpoints (artifacts-presign
    # retry/parts, artifacts-get): an owner link, and 404 otherwise so the
    # endpoint doesn't reveal which artifact ids exist.
    try:
        item = testbed_authz.require_resource(table, user_id, "ARTIFACT", artifact_id, legacy_roles=("owner",))
    except testbed_authz.AuthorizationError:
        return _resp(404, {"error": "Artifact not found"})

    unsupported = sorted(set(body) - UPDATABLE_FIELDS)
    if unsupported:
        return _resp(400, {"error": f"Unsupported field(s): {', '.join(unsupported)}"})

    status = body.get("reverseEngineeringStatus")
    if status not in RE_STATUSES:
        return _resp(400, {
            "error": f"reverseEngineeringStatus must be one of: {', '.join(RE_STATUSES)}"
        })

    key = {"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"}
    if item.get("type") != "firmware":
        return _resp(400, {"error": "reverseEngineeringStatus is only supported for firmware artifacts"})

    now = datetime.now(timezone.utc).isoformat()

    # The condition re-checks both facts on the write itself, so the update
    # can never create a bare ARTIFACT# item or touch a non-firmware one.
    try:
        updated = table.update_item(
            Key=key,
            UpdateExpression="SET reverseEngineeringStatus = :re_status, updatedAt = :now",
            ConditionExpression="attribute_exists(pk) AND #type = :firmware",
            ExpressionAttributeNames={"#type": "type"},
            ExpressionAttributeValues={":re_status": status, ":now": now, ":firmware": "firmware"},
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"error": "Artifact not found"})
        raise

    return _resp(200, {
        "artifactId": artifact_id,
        "type": updated.get("type"),
        "version": updated.get("version"),
        "status": updated.get("status"),
        "reverseEngineeringStatus": updated["reverseEngineeringStatus"],
        "updatedAt": updated.get("updatedAt"),
    })


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://vzoniq.com",
        },
        "body": json.dumps(body),
    }
