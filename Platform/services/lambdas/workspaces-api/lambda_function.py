"""Workspaces: shared projects whose members can use the workspace's resources.

  POST /workspaces                          {name}  create; the caller becomes its owner
  GET  /workspaces                          workspaces the caller belongs to, with their role
  GET  /workspaces/{workspaceId}            workspace + members (members only; owners also
                                            see pending invitations)
  POST /workspaces/{workspaceId}/invites    {email, role?}  owner invites a teammate as a
                                            member (default) or a read-only viewer
  POST /workspaces/{workspaceId}/invites/revoke   {email}  owner withdraws a pending invitation
  DELETE /workspaces/{workspaceId}/members/{userId}  owner removes a member or viewer
  GET  /invites                             invitations addressed to the caller's email
  POST /workspaces/{workspaceId}/accept     accept the invitation addressed to the caller
  POST /workspaces/{workspaceId}/decline    decline it

Roles: owner and member contribute; a viewer can read and download the
workspace's resources but change nothing (testbed_authz.MEMBERSHIP_ROLES vs
CONTRIBUTOR_ROLES). Owners can't be invited or removed.

Membership is the USER#{uid} / WORKSPACE#{wid} row. Access checks go through
the shared testbed_authz layer, so this Lambda never decides membership
itself.

Invitations are addressed to an email address, not a user: whether the
address has an account is never looked up, so it isn't revealed either. The
invitee proves the address with the verified email claim of their Cognito
token, which is the only identity accept and decline use. No email is sent;
the invitee sees pending invitations in the app.
"""
import json
import os
import re
import secrets
import time
import uuid
import boto3
import testbed_authz
from datetime import datetime, timedelta, timezone
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
client = boto3.client("dynamodb")
serializer = TypeSerializer()

TABLE = os.environ["METADATA_TABLE_NAME"]

NAME_MAX_LENGTH = 100
CREATE_FIELDS = {"name"}
INVITE_FIELDS = {"email", "role"}
REVOKE_FIELDS = {"email"}
BATCH_GET_MAX_KEYS = 100

INVITE_TTL = timedelta(days=14)
MAX_PENDING_INVITES = 50
# The roles an invitation may grant; owner never. An invitation without a
# role (none exist, but the rule is explicit) grants member.
INVITABLE_ROLES = ("member", "viewer")
DEFAULT_INVITE_ROLE = "member"
EMAIL_MAX_LENGTH = 254

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def handler(event, context):
    claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("claims") or {}
    user_id = claims.get("sub")
    # API Gateway's Cognito authorizer always supplies the claims; refuse
    # rather than fail if a request ever arrives without them.
    if not isinstance(user_id, str) or not user_id:
        return _resp(401, {"error": "Unauthorized"})

    resource = event.get("resource", "")
    method = event.get("httpMethod", "GET")
    table = dynamodb.Table(TABLE)

    try:
        route = (method, resource)
        if route == ("POST", "/workspaces"):
            return _create_workspace(user_id, claims, _json_body(event))
        if route == ("GET", "/workspaces"):
            return _resp(200, {"workspaces": _list_workspaces(table, user_id)})
        if route == ("GET", "/invites"):
            return _resp(200, {"invites": _list_invites(table, claims)})
        if not resource.startswith("/workspaces/{workspaceId}"):
            return _resp(404, {"error": "Unknown route"})

        workspace_id = _uuid((event.get("pathParameters") or {}).get("workspaceId"), "workspaceId")
        if route == ("GET", "/workspaces/{workspaceId}"):
            return _resp(200, _get_workspace(table, user_id, workspace_id))
        if route == ("POST", "/workspaces/{workspaceId}/invites"):
            return _invite(table, user_id, claims, workspace_id, _json_body(event))
        if route == ("POST", "/workspaces/{workspaceId}/invites/revoke"):
            return _revoke_invite(table, user_id, workspace_id, _json_body(event))
        if route == ("DELETE", "/workspaces/{workspaceId}/members/{userId}"):
            member_id = (event.get("pathParameters") or {}).get("userId")
            return _remove_member(table, user_id, workspace_id, member_id)
        if route == ("POST", "/workspaces/{workspaceId}/accept"):
            _empty_body(event)
            return _accept(table, user_id, claims, workspace_id)
        if route == ("POST", "/workspaces/{workspaceId}/decline"):
            _empty_body(event)
            return _decline(table, claims, workspace_id)
    except RequestError as e:
        return _resp(e.status, {"error": e.message})

    return _resp(404, {"error": "Unknown route"})


# --- POST /workspaces ------------------------------------------------------------

def _create_workspace(user_id, claims, body):
    _reject_unsupported(body, CREATE_FIELDS)
    name = _name(body.get("name"))

    workspace_id = _uuid7()
    now = _iso(_utcnow())
    workspace = {
        "pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA", "entity": "workspace",
        "workspaceId": workspace_id, "name": name,
        "createdBy": user_id, "createdAt": now, "updatedAt": now,
    }
    # The role is fixed here, never taken from the request.
    user_workspace = {
        "pk": f"USER#{user_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace",
        "role": "owner", "name": name, "joinedAt": now,
    }
    workspace_user = {
        "pk": f"WORKSPACE#{workspace_id}", "sk": f"USER#{user_id}", "entity": "workspace-user",
        "role": "owner", "joinedAt": now,
    }
    # Shown to other members, so only an address Cognito has verified. The
    # creator wasn't invited, so invitedBy is left out.
    email = _verified_email(claims)
    if email:
        workspace_user["email"] = email

    _transact([_put(workspace), _put(user_workspace), _put(workspace_user)],
              "create_workspace", workspace_id, {}, (500, "Failed to create workspace"))

    return _resp(201, {"workspace": {**_public_workspace(workspace), "role": "owner"}})


# --- GET /workspaces -------------------------------------------------------------

def _list_workspaces(table, user_id):
    """Newest first. Names come from WORKSPACE#/METADATA, not the copies on the
    membership rows, and a membership whose workspace record is gone is
    skipped."""
    links = _query_all(table, f"USER#{user_id}", "WORKSPACE#")
    roles = {}
    for link in links:
        role = link.get("role")
        if role in testbed_authz.MEMBERSHIP_ROLES:
            roles[link["sk"][len("WORKSPACE#"):]] = role

    by_id = _workspaces_by_id(roles)
    return [
        {**_public_workspace(by_id[wid]), "role": role}
        for wid, role in roles.items() if wid in by_id
    ]


# --- GET /workspaces/{workspaceId} ---------------------------------------------------

def _get_workspace(table, user_id, workspace_id):
    # A non-member gets the same 404 as a workspace that doesn't exist.
    try:
        role = testbed_authz.require_member(table, user_id, workspace_id, roles=testbed_authz.MEMBERSHIP_ROLES)
    except testbed_authz.AuthorizationError:
        raise RequestError(404, "Workspace not found")

    item = table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item")
    if item is None:
        raise RequestError(404, "Workspace not found")

    members = [
        {
            "userId": row["sk"][len("USER#"):],
            "role": row.get("role"),
            "email": row.get("email"),
            "joinedAt": row.get("joinedAt"),
            "invitedBy": row.get("invitedBy"),
        }
        for row in _query_all(table, f"WORKSPACE#{workspace_id}", "USER#", newest_first=False)
    ]
    body = {"workspace": {**_public_workspace(item), "role": role}, "members": members}
    # Pending invitations name people who haven't joined, so only owners,
    # who manage them, see them.
    if role == "owner":
        body["invites"] = [_public_invite(row) for row in _pending_invites(table, workspace_id, _utcnow())]
    return body


# --- POST /workspaces/{workspaceId}/invites ---------------------------------------------

def _invite(table, user_id, claims, workspace_id, body):
    # Non-members get the same 404 as a missing workspace; members know the
    # workspace exists, so they are told why they can't invite.
    try:
        testbed_authz.require_member(table, user_id, workspace_id, roles=("owner",))
    except testbed_authz.NotFound:
        raise RequestError(404, "Workspace not found")
    except testbed_authz.Forbidden:
        raise RequestError(403, "Only workspace owners can invite members")

    _reject_unsupported(body, INVITE_FIELDS)
    email = _email(body.get("email"))
    role = _invite_role(body.get("role", DEFAULT_INVITE_ROLE))
    inviter_email = _verified_email(claims)
    if email == inviter_email:
        raise RequestError(400, "You can't invite yourself")

    workspace = table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item")
    if workspace is None:
        raise RequestError(404, "Workspace not found")

    members = _query_all(table, f"WORKSPACE#{workspace_id}", "USER#")
    if any(row.get("email") == email for row in members):
        raise RequestError(409, "That person is already a member of this workspace")

    now = _utcnow()
    pending = _pending_invites(table, workspace_id, now)
    if any(row.get("email") == email for row in pending):
        raise RequestError(409, "That email already has a pending invitation")
    # Counted before the write, so two concurrent invitations can go a little
    # over the limit; it bounds abuse, it isn't an exact quota.
    if len(pending) >= MAX_PENDING_INVITES:
        raise RequestError(409, f"This workspace already has {MAX_PENDING_INVITES} pending invitations")

    created_at, expires_at = _iso(now), _iso(now + INVITE_TTL)
    invite = {
        "pk": f"WORKSPACE#{workspace_id}", "sk": f"INVITE#{email}", "entity": "workspace-invite",
        "email": email, "role": role, "invitedBy": user_id,
        "createdAt": created_at, "expiresAt": expires_at,
    }
    # The role here is for display only; accept grants the role on the
    # INVITE# row above.
    invitee = {
        "pk": f"INVITEE#{email}", "sk": f"WORKSPACE#{workspace_id}", "entity": "invitee-workspace",
        "workspaceName": workspace.get("name"), "role": role, "invitedBy": user_id,
        "createdAt": created_at, "expiresAt": expires_at,
    }
    if inviter_email:
        invite["invitedByEmail"] = inviter_email
        invitee["invitedByEmail"] = inviter_email

    # Either both rows are written or neither. An earlier invitation to the
    # same address may only be replaced once it has expired, and the owner
    # check is repeated inside the transaction.
    _transact(
        [
            {"ConditionCheck": {
                "TableName": TABLE,
                "Key": _key(f"USER#{user_id}", f"WORKSPACE#{workspace_id}"),
                "ConditionExpression": "#role = :owner",
                "ExpressionAttributeNames": {"#role": "role"},
                "ExpressionAttributeValues": _values({":owner": "owner"}),
            }},
            _put_replacing_expired(invite, created_at),
            _put_replacing_expired(invitee, created_at),
        ],
        "invite", workspace_id,
        {0: (403, "Only workspace owners can invite members"),
         1: (409, "That email already has a pending invitation"),
         2: (409, "That email already has a pending invitation")},
        (500, "Failed to create the invitation"),
    )

    return _resp(201, {"invite": _public_invite(invite)})


# --- GET /invites ------------------------------------------------------------------

def _list_invites(table, claims):
    """Unexpired invitations addressed to the caller's verified email, newest
    first by workspace. Workspace names come from METADATA, and invitations
    to a workspace that no longer exists are skipped."""
    email = _require_verified_email(claims)
    now = _utcnow()
    rows = [row for row in _query_all(table, f"INVITEE#{email}", "WORKSPACE#") if not _expired(row, now)]
    by_id = _workspaces_by_id(row["sk"][len("WORKSPACE#"):] for row in rows)

    invites = []
    for row in rows:
        workspace = by_id.get(row["sk"][len("WORKSPACE#"):])
        if workspace is None:
            continue
        invites.append({
            "workspaceId": workspace["workspaceId"],
            "workspaceName": workspace.get("name"),
            "role": row.get("role") if row.get("role") in INVITABLE_ROLES else DEFAULT_INVITE_ROLE,
            "invitedBy": row.get("invitedBy"),
            "invitedByEmail": row.get("invitedByEmail"),
            "createdAt": row.get("createdAt"),
            "expiresAt": row.get("expiresAt"),
        })
    return invites


# --- POST /workspaces/{workspaceId}/accept -------------------------------------------

def _accept(table, user_id, claims, workspace_id):
    email = _require_verified_email(claims)
    now = _utcnow()

    invite = table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": f"INVITE#{email}"}).get("Item")
    if invite is None:
        raise RequestError(404, "Invitation not found")
    if _expired(invite, now):
        raise RequestError(410, "This invitation has expired")

    workspace = table.get_item(Key={"pk": f"WORKSPACE#{workspace_id}", "sk": "METADATA"}).get("Item")
    if workspace is None:
        raise RequestError(404, "Invitation not found")
    if testbed_authz.workspace_role(table, user_id, workspace_id) is not None:
        raise RequestError(409, "You are already a member of this workspace")

    # The role is the one the owner chose, read from the invitation, never
    # from the request (which has no body). Anything unexpected on the row
    # grants the default member role, as every invitation did before roles
    # existed, and never owner.
    role = invite.get("role") if invite.get("role") in INVITABLE_ROLES else DEFAULT_INVITE_ROLE
    joined_at = _iso(now)
    user_workspace = {
        "pk": f"USER#{user_id}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace",
        "role": role, "name": workspace.get("name"), "joinedAt": joined_at,
    }
    workspace_user = {
        "pk": f"WORKSPACE#{workspace_id}", "sk": f"USER#{user_id}", "entity": "workspace-user",
        "role": role, "email": email, "joinedAt": joined_at,
    }
    if invite.get("invitedBy"):
        workspace_user["invitedBy"] = invite["invitedBy"]

    # The invitation is consumed and the membership created in one step. The
    # invitation must still be the one read above (same expiresAt and role)
    # and unexpired, and neither membership row may exist, so a second
    # accept, concurrent or not, fails without changing anything.
    _transact(
        [
            {"ConditionCheck": {
                "TableName": TABLE,
                "Key": _key(f"WORKSPACE#{workspace_id}", "METADATA"),
                "ConditionExpression": "attribute_exists(pk)",
            }},
            {"Delete": {
                "TableName": TABLE,
                "Key": _key(f"WORKSPACE#{workspace_id}", f"INVITE#{email}"),
                "ConditionExpression": _invite_unchanged_condition(invite),
                "ExpressionAttributeNames": {"#role": "role"},
                "ExpressionAttributeValues": _values({
                    ":expires": invite["expiresAt"], ":now": joined_at,
                    **({":role": invite["role"]} if "role" in invite else {}),
                }),
            }},
            {"Delete": {
                "TableName": TABLE,
                "Key": _key(f"INVITEE#{email}", f"WORKSPACE#{workspace_id}"),
                "ConditionExpression": "attribute_exists(pk)",
            }},
            _put(user_workspace),
            _put(workspace_user),
        ],
        "accept_invite", workspace_id,
        {0: (404, "Invitation not found"),
         1: (409, "This invitation is no longer valid"),
         2: (409, "This invitation is no longer valid"),
         3: (409, "You are already a member of this workspace"),
         4: (409, "You are already a member of this workspace")},
        (500, "Failed to accept the invitation"),
    )

    return _resp(200, {"workspace": {**_public_workspace(workspace), "role": role}})


# --- POST /workspaces/{workspaceId}/decline ------------------------------------------

def _decline(table, claims, workspace_id):
    # The keys are built from the caller's own verified email, so nobody can
    # touch an invitation addressed to someone else. Expired invitations can
    # be declined too, which removes them.
    email = _require_verified_email(claims)
    invite_key = {"pk": f"WORKSPACE#{workspace_id}", "sk": f"INVITE#{email}"}
    invitee_key = {"pk": f"INVITEE#{email}", "sk": f"WORKSPACE#{workspace_id}"}
    if table.get_item(Key=invite_key).get("Item") is None and table.get_item(Key=invitee_key).get("Item") is None:
        raise RequestError(404, "Invitation not found")

    # Both deletes are unconditional, so a half-present invitation is still
    # cleaned up, and repeating a decline changes nothing.
    _transact(
        [
            {"Delete": {"TableName": TABLE, "Key": _key(invite_key["pk"], invite_key["sk"])}},
            {"Delete": {"TableName": TABLE, "Key": _key(invitee_key["pk"], invitee_key["sk"])}},
        ],
        "decline_invite", workspace_id, {}, (500, "Failed to decline the invitation"),
    )
    return _resp(200, {"declined": True, "workspaceId": workspace_id})


# --- POST /workspaces/{workspaceId}/invites/revoke ----------------------------------

def _revoke_invite(table, user_id, workspace_id, body):
    _require_owner(table, user_id, workspace_id, "Only workspace owners can revoke invitations")
    _reject_unsupported(body, REVOKE_FIELDS)
    email = _email(body.get("email"))

    invite_key = {"pk": f"WORKSPACE#{workspace_id}", "sk": f"INVITE#{email}"}
    invitee_key = {"pk": f"INVITEE#{email}", "sk": f"WORKSPACE#{workspace_id}"}
    if table.get_item(Key=invite_key).get("Item") is None and table.get_item(Key=invitee_key).get("Item") is None:
        raise RequestError(404, "Invitation not found")

    # Both rows go together, with the owner check repeated inside the
    # transaction. The deletes are unconditional, like decline, so a
    # half-present invitation is cleaned up and repeating it changes nothing.
    _transact(
        [
            _owner_check(user_id, workspace_id),
            {"Delete": {"TableName": TABLE, "Key": _key(invite_key["pk"], invite_key["sk"])}},
            {"Delete": {"TableName": TABLE, "Key": _key(invitee_key["pk"], invitee_key["sk"])}},
        ],
        "revoke_invite", workspace_id,
        {0: (403, "Only workspace owners can revoke invitations")},
        (500, "Failed to revoke the invitation"),
    )
    return _resp(200, {"revoked": True, "email": email, "workspaceId": workspace_id})


# --- DELETE /workspaces/{workspaceId}/members/{userId} -----------------------------

def _remove_member(table, user_id, workspace_id, member_id):
    _require_owner(table, user_id, workspace_id, "Only workspace owners can remove members")
    # A Cognito sub; it becomes a key component, so no "#" or control characters.
    if (not isinstance(member_id, str) or not member_id or len(member_id) > 128 or "#" in member_id
            or any(ord(c) < 0x20 or ord(c) == 0x7f for c in member_id)):
        raise RequestError(400, "userId is invalid")
    if member_id == user_id:
        raise RequestError(400, "Owners can't remove themselves")

    # Removing the USER#/WORKSPACE# row ends access at once: every endpoint
    # reads it on every request. Resources the member created stay with the
    # workspace.
    role = testbed_authz.workspace_role(table, member_id, workspace_id)
    if role is None:
        raise RequestError(404, "Member not found")
    if role == "owner":
        raise RequestError(403, "Owners can't be removed")

    _transact(
        [
            _owner_check(user_id, workspace_id),
            {"Delete": {
                "TableName": TABLE,
                "Key": _key(f"USER#{member_id}", f"WORKSPACE#{workspace_id}"),
                "ConditionExpression": "attribute_exists(pk) AND #role <> :owner",
                "ExpressionAttributeNames": {"#role": "role"},
                "ExpressionAttributeValues": _values({":owner": "owner"}),
            }},
            {"Delete": {
                "TableName": TABLE,
                "Key": _key(f"WORKSPACE#{workspace_id}", f"USER#{member_id}"),
                "ConditionExpression": "attribute_not_exists(#role) OR #role <> :owner",
                "ExpressionAttributeNames": {"#role": "role"},
                "ExpressionAttributeValues": _values({":owner": "owner"}),
            }},
        ],
        "remove_member", workspace_id,
        {0: (403, "Only workspace owners can remove members"),
         1: (404, "Member not found"),
         2: (403, "Owners can't be removed")},
        (500, "Failed to remove the member"),
    )
    return _resp(200, {"removed": True, "userId": member_id, "workspaceId": workspace_id})


# --- Helpers -----------------------------------------------------------------------

def _require_owner(table, user_id, workspace_id, forbidden_message):
    # Non-members get the same 404 as a missing workspace; members and
    # viewers know the workspace exists, so they are told why.
    try:
        testbed_authz.require_member(table, user_id, workspace_id, roles=("owner",))
    except testbed_authz.NotFound:
        raise RequestError(404, "Workspace not found")
    except testbed_authz.Forbidden:
        raise RequestError(403, forbidden_message)


def _owner_check(user_id, workspace_id):
    return {"ConditionCheck": {
        "TableName": TABLE,
        "Key": _key(f"USER#{user_id}", f"WORKSPACE#{workspace_id}"),
        "ConditionExpression": "#role = :owner",
        "ExpressionAttributeNames": {"#role": "role"},
        "ExpressionAttributeValues": _values({":owner": "owner"}),
    }}


def _invite_role(value):
    if value not in INVITABLE_ROLES:
        raise RequestError(400, f"role must be one of: {', '.join(INVITABLE_ROLES)}")
    return value


def _invite_unchanged_condition(invite):
    # The role is part of what was read: an invitation replaced (after it
    # expired) with another role between the read and the write can't be
    # accepted with the role read earlier.
    role = "#role = :role" if "role" in invite else "attribute_not_exists(#role)"
    return f"attribute_exists(pk) AND expiresAt = :expires AND expiresAt > :now AND {role}"


def _public_workspace(item):
    return {
        "workspaceId": item["workspaceId"],
        "name": item.get("name"),
        "createdBy": item.get("createdBy"),
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }


def _public_invite(item):
    return {
        "email": item.get("email"),
        "role": item.get("role"),
        "invitedBy": item.get("invitedBy"),
        "invitedByEmail": item.get("invitedByEmail"),
        "createdAt": item.get("createdAt"),
        "expiresAt": item.get("expiresAt"),
    }


def _pending_invites(table, workspace_id, now):
    return [row for row in _query_all(table, f"WORKSPACE#{workspace_id}", "INVITE#", newest_first=False)
            if not _expired(row, now)]


def _workspaces_by_id(workspace_ids):
    keys = [{"pk": f"WORKSPACE#{wid}", "sk": "METADATA"} for wid in dict.fromkeys(workspace_ids)]
    return {item["workspaceId"]: item for item in _batch_get(keys) if item.get("workspaceId")}


def _expired(item, now):
    # A missing or unreadable expiry counts as expired, so a malformed row
    # never stays valid forever.
    try:
        expires_at = datetime.fromisoformat(item["expiresAt"])
    except (KeyError, TypeError, ValueError):
        return True
    if expires_at.tzinfo is None:
        return True
    return expires_at <= now


def _verified_email(claims):
    # REST API authorizer claims are strings, so email_verified is "true".
    email = claims.get("email")
    if claims.get("email_verified") != "true" or not isinstance(email, str) or not email.strip():
        return None
    return email.strip().lower()


def _require_verified_email(claims):
    email = _verified_email(claims)
    if email is None:
        raise RequestError(403, "A verified email address is required")
    return email


def _email(value):
    if not isinstance(value, str) or not value.strip():
        raise RequestError(400, "email is required")
    email = value.strip().lower()
    if len(email) > EMAIL_MAX_LENGTH or not EMAIL_PATTERN.match(email) or any(
        ord(c) < 0x20 or ord(c) == 0x7f for c in email
    ):
        raise RequestError(400, "email is invalid")
    return email


def _json_body(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        raise RequestError(400, "Invalid JSON in request body")
    if not isinstance(body, dict):
        raise RequestError(400, "Invalid JSON in request body")
    return body


def _empty_body(event):
    # Accept and decline act only on the token's identity; nothing in the
    # request can name a different email or user.
    if _json_body(event):
        raise RequestError(400, "This request takes no body")


def _reject_unsupported(body, allowed):
    unsupported = sorted(set(body) - allowed)
    if unsupported:
        raise RequestError(400, f"Unsupported field(s): {', '.join(unsupported)}")


def _name(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        raise RequestError(400, "name is required")
    if not isinstance(value, str) or len(value.strip()) > NAME_MAX_LENGTH or any(
        ord(c) < 0x20 or ord(c) == 0x7f for c in value
    ):
        raise RequestError(400, f"name is invalid (max {NAME_MAX_LENGTH} characters, no control characters)")
    return value.strip()


def _uuid(value, name):
    if not isinstance(value, str) or not UUID_PATTERN.match(value):
        raise RequestError(400, f"{name} is invalid")
    return value


def _query_all(table, pk, prefix, newest_first=True):
    items, kwargs = [], {
        "KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix),
        "ScanIndexForward": not newest_first,
    }
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _batch_get(keys):
    items = []
    for start in range(0, len(keys), BATCH_GET_MAX_KEYS):
        request = {TABLE: {"Keys": keys[start:start + BATCH_GET_MAX_KEYS]}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            items += result.get("Responses", {}).get(TABLE, [])
            request = result.get("UnprocessedKeys") or None
    return items


def _transact(items, action, workspace_id, failures, fallback):
    """TransactWriteItems. A cancellation is mapped to an error by the index
    of the first item whose condition failed; anything else becomes
    `fallback` and is logged."""
    try:
        client.transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        reasons = e.response.get("CancellationReasons", [])
        for index, reason in enumerate(reasons):
            if reason.get("Code") == "ConditionalCheckFailed" and index in failures:
                raise RequestError(*failures[index])
        print(json.dumps({
            "event": f"{action}_transaction_canceled",
            "workspaceId": workspace_id,
            "cancellationReasons": [{"code": r.get("Code"), "message": r.get("Message")} for r in reasons],
        }))
        if any(r.get("Code") == "TransactionConflict" for r in reasons):
            raise RequestError(409, "Another change to this workspace is in progress; try again")
        raise RequestError(*fallback)


def _uuid7():
    # Time-ordered UUID (RFC 9562 version 7), so USER#/WORKSPACE# rows list
    # newest first with ScanIndexForward=False.
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= secrets.randbits(80)
    value &= ~(0xF << 76)
    value |= 0x7 << 76
    value &= ~(0x3 << 62)
    value |= 0x2 << 62
    return str(uuid.UUID(int=value))


def _utcnow():
    return datetime.now(timezone.utc)


def _iso(value):
    # Always with microseconds, so timestamps compare correctly as strings in
    # DynamoDB condition expressions (expiresAt > :now).
    return value.isoformat(timespec="microseconds")


def _key(pk, sk):
    return {"pk": serializer.serialize(pk), "sk": serializer.serialize(sk)}


def _values(values):
    return {k: serializer.serialize(v) for k, v in values.items()}


def _put(item):
    return {"Put": {"TableName": TABLE, "Item": {k: serializer.serialize(v) for k, v in item.items()},
                    "ConditionExpression": "attribute_not_exists(pk)"}}


def _put_replacing_expired(item, now):
    return {"Put": {"TableName": TABLE, "Item": {k: serializer.serialize(v) for k, v in item.items()},
                    "ConditionExpression": "attribute_not_exists(pk) OR expiresAt <= :now",
                    "ExpressionAttributeValues": _values({":now": now})}}


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://vzoniq.com"},
        "body": json.dumps(body),
    }
