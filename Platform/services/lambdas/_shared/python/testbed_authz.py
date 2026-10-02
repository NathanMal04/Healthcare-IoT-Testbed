"""Shared authorization checks for the metadata table.

Deployed as a Lambda layer (Platform/infra/envs/dev/shared.tf), so it is
importable as `testbed_authz` from every function that uses the layer.

A resource is authorized one of two ways, chosen by its METADATA record:

- With a `workspaceId`: the caller needs a USER#{sub} / WORKSPACE#{id}
  membership row with an accepted role. The caller's USER#/X# ownership
  links are ignored, so a legacy link can never bypass membership.
- Without one (every resource today): the existing USER#{sub} / X#{id}
  ownership link, with the role the endpoint requires.

The helpers raise instead of returning HTTP responses, because endpoints map
the same outcome to different status codes (the device endpoints answer 403,
the artifact endpoints 404).
"""

WORKSPACE_ROLES = ("owner", "member")

# Pass as legacy_roles to accept a USER#/X# link whatever its role (the read
# rule artifacts-get uses today).
ANY_ROLE = None


class AuthorizationError(Exception):
    """Base class: the caller may not use the resource or workspace."""


class NotFound(AuthorizationError):
    """The resource (its METADATA record) or the workspace membership doesn't exist."""


class Forbidden(AuthorizationError):
    """The resource exists, but the caller has no access or not the required role."""


def workspace_role(table, user_id, workspace_id):
    """The caller's role in the workspace, or None if they aren't a member."""
    if not _is_id(user_id) or not _is_id(workspace_id):
        return None
    item = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"WORKSPACE#{workspace_id}"}).get("Item")
    role = (item or {}).get("role")
    return role if role in WORKSPACE_ROLES else None


def require_member(table, user_id, workspace_id, roles=WORKSPACE_ROLES):
    """Returns the caller's role in the workspace.

    Raises NotFound if they aren't a member (so a workspace's existence isn't
    revealed) and Forbidden if they are, but not in one of `roles`.
    """
    role = workspace_role(table, user_id, workspace_id)
    if role is None:
        raise NotFound("Workspace not found")
    if role not in roles:
        raise Forbidden("Workspace role not permitted")
    return role


def require_resource(table, user_id, kind, resource_id, *, legacy_roles=("owner",),
                     workspace_roles=WORKSPACE_ROLES):
    """Returns the resource's METADATA item if the caller may use it.

    `kind` is the key prefix (DEVICE, ARTIFACT, ...). `legacy_roles` are the
    USER#/X# link roles accepted for a resource without a workspaceId
    (ANY_ROLE accepts any link). `workspace_roles` are the membership roles
    accepted for a resource with one.

    Raises NotFound if the METADATA record doesn't exist, and Forbidden if it
    does but the caller isn't authorized.
    """
    if not _is_id(user_id) or not _is_id(kind) or not _is_id(resource_id):
        raise NotFound("Resource not found")

    item = table.get_item(Key={"pk": f"{kind}#{resource_id}", "sk": "METADATA"}).get("Item")
    if item is None:
        raise NotFound("Resource not found")

    if "workspaceId" in item:
        # Fails closed: a malformed workspaceId authorizes nobody, and the
        # legacy ownership path is never consulted.
        role = workspace_role(table, user_id, item["workspaceId"])
        if role is None or role not in workspace_roles:
            raise Forbidden("Not authorized for this resource")
        return item

    link = table.get_item(Key={"pk": f"USER#{user_id}", "sk": f"{kind}#{resource_id}"}).get("Item")
    if link is None or (legacy_roles is not ANY_ROLE and link.get("role") not in legacy_roles):
        raise Forbidden("Not authorized for this resource")
    return item


def _is_id(value):
    # Ids become key components, so an empty value or a "#" could address a
    # different row than intended.
    return isinstance(value, str) and value != "" and "#" not in value
