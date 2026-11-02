import json
import os
import re
import boto3
import image_fields
import testbed_authz
from datetime import datetime, timezone
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]

# reverseEngineeringStatus is reverse-engineering progress on a firmware
# artifact. It is separate from the upload lifecycle "status"
# (pending/verifying/ready/failed), which this endpoint never touches.
RE_STATUSES = ("not_started", "in_progress", "complete")
# reverseEngineeringStatus: firmware only. title, description, capturedAt:
# images only (image_fields). Each is refused on artifacts of other types.
FIRMWARE_FIELDS = {"reverseEngineeringStatus"}
IMAGE_FIELDS = set(image_fields.EDITABLE_FIELDS)
UPDATABLE_FIELDS = FIRMWARE_FIELDS | IMAGE_FIELDS

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def handler(event, context):
    """PATCH /artifacts/{artifactId}.

    Firmware: {"reverseEngineeringStatus": ...}. Images: any of "title",
    "description" and "capturedAt" (null or "" removes description and
    capturedAt; title can be changed but not removed).
    """
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

    if item.get("type") == image_fields.IMAGE_TYPE:
        if "reverseEngineeringStatus" in body:
            return _resp(400, {"error": "reverseEngineeringStatus is only supported for firmware artifacts"})
        return _update_image(table, artifact_id, body)
    image_only = sorted(set(body) & IMAGE_FIELDS)
    if image_only:
        return _resp(400, {"error": f"{', '.join(image_only)} only supported for image artifacts"})

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


def _update_image(table, artifact_id, body):
    if not body:
        return _resp(400, {"error": f"At least one of {', '.join(image_fields.EDITABLE_FIELDS)} is required"})

    sets, removes = {}, []
    try:
        if "title" in body:
            sets["title"] = image_fields.clean_title(body["title"])
        for field, clean in (("description", image_fields.clean_description),
                             ("capturedAt", image_fields.clean_captured_at)):
            if field in body:
                value = clean(body[field])
                if value is None:
                    removes.append(field)
                else:
                    sets[field] = value
    except image_fields.FieldError as e:
        return _resp(400, {"error": str(e)})

    names = {"#type": "type", **{f"#{f}": f for f in [*sets, *removes]}}
    values = {":image": image_fields.IMAGE_TYPE, ":now": datetime.now(timezone.utc).isoformat()}
    assignments = ["updatedAt = :now"]
    for field, value in sets.items():
        assignments.append(f"#{field} = :{field}")
        values[f":{field}"] = value
    expression = f"SET {', '.join(assignments)}"
    if removes:
        expression += f" REMOVE {', '.join(f'#{f}' for f in removes)}"

    # As for firmware, the condition re-checks on the write that the record
    # exists and is still an image.
    try:
        updated = table.update_item(
            Key={"pk": f"ARTIFACT#{artifact_id}", "sk": "METADATA"},
            UpdateExpression=expression,
            ConditionExpression="attribute_exists(pk) AND #type = :image",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"error": "Artifact not found"})
        raise

    return _resp(200, {
        "artifactId": artifact_id,
        "type": updated.get("type"),
        "status": updated.get("status"),
        **image_fields.public_fields(updated),
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
