"""Unit tests for the shared authorization layer (_shared/python/testbed_authz.py),
with DynamoDB replaced by an in-memory fake.

Workspace rows here are hypothetical: nothing writes them yet (Stage 3A.1
adds the workspace API). They pin down how require_resource will treat a
resource once it has a workspaceId.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import sys
import unittest
from pathlib import Path

LAMBDAS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAMBDAS / "_shared" / "python"))

import testbed_authz  # noqa: E402
from testbed_authz import ANY_ROLE, Forbidden, NotFound, require_member, require_resource, workspace_role  # noqa: E402

USER = "user-sub-1"
OTHER_USER = "user-sub-2"
DEVICE = "11111111-1111-4111-8111-111111111111"
ARTIFACT = "0192a000-0000-7000-8000-000000000001"
WORKSPACE = "0192b000-0000-7000-8000-000000000001"
OTHER_WORKSPACE = "0192b000-0000-7000-8000-000000000002"


class FakeTable:
    def __init__(self, rows):
        self.items = {(r["pk"], r["sk"]): dict(r) for r in rows}
        self.reads = []

    def get_item(self, Key):
        self.reads.append((Key["pk"], Key["sk"]))
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item else {}


def metadata(kind, resource_id, **extra):
    return {"pk": f"{kind}#{resource_id}", "sk": "METADATA", "entity": kind.lower(), **extra}


def owner_link(kind, resource_id, user=USER, role="owner"):
    return {"pk": f"USER#{user}", "sk": f"{kind}#{resource_id}", "entity": f"user-{kind.lower()}", "role": role}


def membership(workspace_id=WORKSPACE, user=USER, role="member"):
    return {"pk": f"USER#{user}", "sk": f"WORKSPACE#{workspace_id}", "entity": "user-workspace", "role": role}


class LegacyResourceTests(unittest.TestCase):
    """Resources without a workspaceId: every device and artifact today."""

    def test_owned_resource_succeeds(self):
        table = FakeTable([metadata("DEVICE", DEVICE, name="Pump"), owner_link("DEVICE", DEVICE)])
        item = require_resource(table, USER, "DEVICE", DEVICE)
        self.assertEqual(item["name"], "Pump")

    def test_unowned_resource_is_forbidden(self):
        table = FakeTable([metadata("DEVICE", DEVICE), owner_link("DEVICE", DEVICE, user=OTHER_USER)])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE)

    def test_default_requires_owner_role(self):
        table = FakeTable([metadata("ARTIFACT", ARTIFACT), owner_link("ARTIFACT", ARTIFACT, role="viewer")])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "ARTIFACT", ARTIFACT)

    def test_link_without_role_is_not_owner(self):
        link = owner_link("ARTIFACT", ARTIFACT)
        del link["role"]
        table = FakeTable([metadata("ARTIFACT", ARTIFACT), link])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "ARTIFACT", ARTIFACT)

    def test_any_role_accepts_any_link(self):
        # The artifacts-get read rule.
        for role in ("owner", "viewer", None):
            with self.subTest(role=role):
                link = owner_link("ARTIFACT", ARTIFACT, role=role)
                table = FakeTable([metadata("ARTIFACT", ARTIFACT), link])
                require_resource(table, USER, "ARTIFACT", ARTIFACT, legacy_roles=ANY_ROLE)

    def test_any_role_still_needs_a_link(self):
        table = FakeTable([metadata("ARTIFACT", ARTIFACT)])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "ARTIFACT", ARTIFACT, legacy_roles=ANY_ROLE)

    def test_custom_legacy_roles(self):
        table = FakeTable([metadata("DEVICE", DEVICE), owner_link("DEVICE", DEVICE, role="viewer")])
        require_resource(table, USER, "DEVICE", DEVICE, legacy_roles=("owner", "viewer"))

    def test_link_to_a_different_kind_does_not_count(self):
        # USER#/ARTIFACT#{id} doesn't authorize DEVICE#{id}, even with the same id.
        table = FakeTable([metadata("DEVICE", DEVICE), owner_link("ARTIFACT", DEVICE)])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE)

    def test_workspace_membership_does_not_authorize_a_legacy_resource(self):
        table = FakeTable([metadata("DEVICE", DEVICE), membership(role="owner")])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE)


class WorkspaceResourceTests(unittest.TestCase):
    """Hypothetical resources with a workspaceId (none exist until Stage 3A.3)."""

    def test_member_succeeds(self):
        table = FakeTable([metadata("DEVICE", DEVICE, workspaceId=WORKSPACE), membership(role="member")])
        item = require_resource(table, USER, "DEVICE", DEVICE)
        self.assertEqual(item["workspaceId"], WORKSPACE)

    def test_owner_succeeds(self):
        table = FakeTable([metadata("DEVICE", DEVICE, workspaceId=WORKSPACE), membership(role="owner")])
        require_resource(table, USER, "DEVICE", DEVICE)

    def test_non_member_is_forbidden(self):
        table = FakeTable([
            metadata("DEVICE", DEVICE, workspaceId=WORKSPACE),
            membership(user=OTHER_USER),
        ])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE)

    def test_member_of_another_workspace_is_forbidden(self):
        table = FakeTable([
            metadata("ARTIFACT", ARTIFACT, workspaceId=WORKSPACE),
            membership(workspace_id=OTHER_WORKSPACE, role="owner"),
        ])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "ARTIFACT", ARTIFACT)

    def test_legacy_owner_link_does_not_bypass_membership(self):
        # A migrated resource keeps its old USER# rows; they must stop granting access.
        table = FakeTable([
            metadata("DEVICE", DEVICE, workspaceId=WORKSPACE),
            owner_link("DEVICE", DEVICE),
        ])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE)
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE, legacy_roles=ANY_ROLE)
        self.assertNotIn((f"USER#{USER}", f"DEVICE#{DEVICE}"), table.reads)

    def test_legacy_roles_do_not_apply_to_members(self):
        # legacy_roles=("owner",) is about USER#/X# links, not workspace roles.
        table = FakeTable([metadata("DEVICE", DEVICE, workspaceId=WORKSPACE), membership(role="member")])
        require_resource(table, USER, "DEVICE", DEVICE, legacy_roles=("owner",))

    def test_workspace_roles_restrict_access(self):
        table = FakeTable([metadata("DEVICE", DEVICE, workspaceId=WORKSPACE), membership(role="member")])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE, workspace_roles=("owner",))
        table.items[(f"USER#{USER}", f"WORKSPACE#{WORKSPACE}")]["role"] = "owner"
        require_resource(table, USER, "DEVICE", DEVICE, workspace_roles=("owner",))

    def test_unknown_membership_role_is_forbidden(self):
        table = FakeTable([metadata("DEVICE", DEVICE, workspaceId=WORKSPACE), membership(role="admin")])
        with self.assertRaises(Forbidden):
            require_resource(table, USER, "DEVICE", DEVICE)

    def test_malformed_workspace_id_fails_closed(self):
        for bad in ("", None, 7, "a#b", ["x"]):
            with self.subTest(workspace_id=bad):
                table = FakeTable([
                    metadata("DEVICE", DEVICE, workspaceId=bad),
                    owner_link("DEVICE", DEVICE),
                    membership(),
                ])
                with self.assertRaises(Forbidden):
                    require_resource(table, USER, "DEVICE", DEVICE)


class MissingResourceTests(unittest.TestCase):
    def test_missing_metadata_is_not_found(self):
        table = FakeTable([])
        with self.assertRaises(NotFound):
            require_resource(table, USER, "DEVICE", DEVICE)

    def test_owner_link_without_metadata_is_not_found(self):
        table = FakeTable([owner_link("ARTIFACT", ARTIFACT)])
        with self.assertRaises(NotFound):
            require_resource(table, USER, "ARTIFACT", ARTIFACT)

    def test_invalid_key_parts_are_not_found_without_a_read(self):
        table = FakeTable([metadata("DEVICE", DEVICE), owner_link("DEVICE", DEVICE)])
        for user, kind, resource_id in (
            ("", "DEVICE", DEVICE), (None, "DEVICE", DEVICE), (USER, "", DEVICE),
            (USER, "DEVICE", ""), (USER, "DEVICE", None), (USER, "DEVICE", f"{DEVICE}#x"),
            (f"{USER}#x", "DEVICE", DEVICE),
        ):
            with self.subTest(user=user, kind=kind, resource_id=resource_id):
                with self.assertRaises(NotFound):
                    require_resource(table, user, kind, resource_id)
        self.assertEqual(table.reads, [])

    def test_both_errors_share_a_base_class(self):
        self.assertTrue(issubclass(NotFound, testbed_authz.AuthorizationError))
        self.assertTrue(issubclass(Forbidden, testbed_authz.AuthorizationError))


class MembershipTests(unittest.TestCase):
    def test_workspace_role(self):
        table = FakeTable([membership(role="owner"), membership(workspace_id=OTHER_WORKSPACE, role="member")])
        self.assertEqual(workspace_role(table, USER, WORKSPACE), "owner")
        self.assertEqual(workspace_role(table, USER, OTHER_WORKSPACE), "member")
        self.assertIsNone(workspace_role(table, OTHER_USER, WORKSPACE))

    def test_workspace_role_ignores_unknown_or_missing_roles(self):
        row = membership()
        del row["role"]
        table = FakeTable([row, membership(workspace_id=OTHER_WORKSPACE, role="admin")])
        self.assertIsNone(workspace_role(table, USER, WORKSPACE))
        self.assertIsNone(workspace_role(table, USER, OTHER_WORKSPACE))

    def test_workspace_role_rejects_invalid_ids_without_a_read(self):
        table = FakeTable([membership()])
        for user, workspace_id in ((USER, ""), (USER, None), (USER, "a#b"), ("", WORKSPACE), (None, WORKSPACE)):
            with self.subTest(user=user, workspace_id=workspace_id):
                self.assertIsNone(workspace_role(table, user, workspace_id))
        self.assertEqual(table.reads, [])

    def test_require_member(self):
        table = FakeTable([membership(role="member")])
        self.assertEqual(require_member(table, USER, WORKSPACE), "member")

    def test_require_member_non_member_is_not_found(self):
        table = FakeTable([membership(user=OTHER_USER)])
        with self.assertRaises(NotFound):
            require_member(table, USER, WORKSPACE)

    def test_require_member_role_requirement(self):
        table = FakeTable([membership(role="member")])
        with self.assertRaises(Forbidden):
            require_member(table, USER, WORKSPACE, roles=("owner",))
        table.items[(f"USER#{USER}", f"WORKSPACE#{WORKSPACE}")]["role"] = "owner"
        self.assertEqual(require_member(table, USER, WORKSPACE, roles=("owner",)), "owner")


if __name__ == "__main__":
    unittest.main()
