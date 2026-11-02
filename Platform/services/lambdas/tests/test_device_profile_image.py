"""Device profile pictures: PATCH /devices/{id} {"profileImageArtifactId"}
(update-device) and the field in GET /devices and GET /devices/{id}
(list-devices), on the artifact tests' world with images uploaded through
the real artifacts-presign and artifacts-complete.

A device's profile picture is a reference to one of its own ready gallery
images. Setting, changing or removing it never changes or deletes an image.

World (test_workspace_artifacts): W1 has USER (owner) and MEMBER, W2 has
W2_OWNER, OUTSIDER belongs to neither. D1 and D2 are W1 devices, D3 a W2
device, DP is USER's personal device.

    pip install boto3
    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_device_lambdas as devices  # noqa: E402  (device fakes: generic expressions)
import test_image_replacement as replacement  # noqa: E402  (image world, replacement helpers)
import test_workspace_artifacts as base  # noqa: E402

USER, MEMBER, W2_OWNER, OUTSIDER = base.USER, base.MEMBER, base.W2_OWNER, base.OUTSIDER
W1, D1, D2, D3, DP = base.W1, base.D1, base.D2, base.D3, base.DP
PNG, SVG = replacement.PNG, replacement.SVG
response_body = base.response_body
FIELD = "profileImageArtifactId"
UNKNOWN = "0192a000-0000-7000-8000-0000000000ff"
NOT_USABLE = f"{FIELD} must be a ready image of this device"


class ProfileImageTestCase(replacement.ReplacementTestCase):
    def setUp(self):
        super().setUp()
        # The device Lambdas see the same rows through the device tests'
        # fakes, which evaluate any condition and update expression.
        self.device_table = devices.FakeTable([])
        self.device_table.items = self.table.items
        self.device_client = devices.cves_fakes.FakeClient(self.device_table)

    def device_lambda(self, name):
        key = f"device:{name}"
        if key not in self.modules:
            module = devices.load_lambda(name)
            module.dynamodb = devices.FakeResource(self.device_table)
            module.client = self.device_client
            self.modules[key] = module
        return self.modules[key]

    def patch_device(self, user, device_id, body):
        return self.device_lambda("update-device").handler(
            devices.event(user=user, body=body, device_id=device_id), None)

    def set_profile(self, user, device_id, artifact_id):
        return self.patch_device(user, device_id, {FIELD: artifact_id})

    def get_device(self, user, device_id):
        resp = self.device_lambda("list-devices").handler(
            devices.event(user=user, device_id=device_id, resource="/devices/{deviceId}"), None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return response_body(resp)

    def list_devices(self, user, workspace_id=None):
        query = {"workspaceId": workspace_id} if workspace_id else None
        resp = self.device_lambda("list-devices").handler(devices.event(user=user, query=query), None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return {d["deviceId"]: d for d in response_body(resp)["devices"]}

    def device_meta(self, device_id):
        return self.table.items[(f"DEVICE#{device_id}", "METADATA")]

    def image_rows(self):
        """Every artifact row (records and links), to show nothing about images changes."""
        return {k: copy.deepcopy(v) for k, v in self.table.items.items()
                if k[0].startswith("ARTIFACT#") or k[1].startswith("ARTIFACT#")}


class SetProfileImageTests(ProfileImageTestCase):
    def test_owner_sets_a_personal_devices_profile_picture(self):
        image = self.ready_image(USER, [DP])
        images_before = self.image_rows()
        before = copy.deepcopy(self.device_meta(DP))
        resp = self.set_profile(USER, DP, image)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        self.assertEqual(response_body(resp)[FIELD], image)

        meta = self.device_meta(DP)
        self.assertEqual(meta[FIELD], image)
        # Only the reference and updatedAt changed: no other device field,
        # no image record or link, and nothing was copied.
        self.assertEqual({k: v for k, v in meta.items() if k not in (FIELD, "updatedAt")}, before)
        self.assertEqual(self.image_rows(), images_before)

        self.assertEqual(self.get_device(USER, DP)[FIELD], image)
        self.assertEqual(self.list_devices(USER)[DP][FIELD], image)

    def test_any_workspace_member_sets_a_workspace_devices_profile_picture(self):
        image = self.ready_image(USER, [D1])
        resp = self.set_profile(MEMBER, D1, image)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        self.assertEqual(self.list_devices(MEMBER, W1)[D1][FIELD], image)
        self.assertEqual(self.get_device(USER, D1)[FIELD], image)

    def test_people_without_device_edit_permission_are_refused(self):
        personal = self.ready_image(USER, [DP], name="p.png")
        workspace = self.ready_image(USER, [D1], name="w.png")
        for user, device_id, image in ((MEMBER, DP, personal), (OUTSIDER, DP, personal), (W2_OWNER, DP, personal),
                                       (OUTSIDER, D1, workspace), (W2_OWNER, D1, workspace)):
            with self.subTest(user=user, device=device_id):
                resp = self.set_profile(user, device_id, image)
                self.assertEqual(resp["statusCode"], 403, resp["body"])
                self.assertNotIn(FIELD, self.device_meta(device_id))
                # Clearing is a device edit too.
                resp = self.set_profile(user, device_id, None)
                self.assertEqual(resp["statusCode"], 403, resp["body"])
        self.assertEqual(self.set_profile(USER, UNKNOWN, personal)["statusCode"], 404)

    def test_only_a_ready_image_of_this_device_in_its_scope_can_be_chosen(self):
        own = self.ready_image(USER, [D1], name="own.png")
        other_device = self.ready_image(USER, [D2], name="d2.png")
        other_workspace = self.ready_image(W2_OWNER, [D3], name="d3.png")
        personal = self.ready_image(USER, [DP], name="personal.png")
        pending = self.presign_one(USER, self.image(name="pending.png"), [D1])["artifactId"]
        failed = self.presign_one(USER, self.image(name="failed.png"), [D1])["artifactId"]
        self.assertEqual(self.complete(USER, failed, SVG)["status"], 422)
        firmware = base.WorldTestCase.upload(self, USER, [D1])  # a ready firmware artifact of D1
        cases = {
            "another device's image": other_device,
            "another workspace's image": other_workspace,
            "a personal image": personal,
            "a pending image": pending,
            "a failed image": failed,
            "not an image": firmware,
            "an id that doesn't exist": UNKNOWN,
        }
        for label, artifact_id in cases.items():
            with self.subTest(label):
                resp = self.set_profile(MEMBER, D1, artifact_id)
                self.assertEqual(resp["statusCode"], 400, resp["body"])
                # The same answer whatever the reason, so ids can't be probed.
                self.assertEqual(response_body(resp)["error"], NOT_USABLE)
        for bad in ("not-an-id", 12, ["x"], {"id": own}):
            with self.subTest(bad=bad):
                resp = self.set_profile(MEMBER, D1, bad)
                self.assertEqual(resp["statusCode"], 400, resp["body"])
                self.assertIn("must be an artifact id or null", response_body(resp)["error"])
        self.assertNotIn(FIELD, self.device_meta(D1))
        # And the personal device can't use the workspace image either.
        self.assertEqual(self.set_profile(USER, DP, own)["statusCode"], 400)

    def test_an_image_whose_device_link_is_gone_is_refused(self):
        image = self.ready_image(USER, [DP])
        del self.table.items[(f"DEVICE#{DP}", f"ARTIFACT#image#{image}")]
        resp = self.set_profile(USER, DP, image)
        self.assertEqual((resp["statusCode"], response_body(resp)["error"]), (400, NOT_USABLE))

    def test_an_image_changed_after_it_was_checked_is_never_referenced(self):
        image = self.ready_image(USER, [DP])
        changes = {
            "link removed": lambda t: t.items.pop((f"DEVICE#{DP}", f"ARTIFACT#image#{image}")),
            "no longer ready": lambda t: t.items[(f"ARTIFACT#{image}", "METADATA")].update(status="failed"),
            "record removed": lambda t: t.items.pop((f"ARTIFACT#{image}", "METADATA")),
        }
        for label, change in changes.items():
            with self.subTest(label):
                snapshot = copy.deepcopy(self.table.items)
                self.device_client.before_transact = change
                try:
                    resp = self.set_profile(USER, DP, image)
                finally:
                    self.device_client.before_transact = None
                self.assertEqual((resp["statusCode"], response_body(resp)["error"]), (400, NOT_USABLE))
                self.assertNotIn(FIELD, self.device_meta(DP))
                self.table.items.clear()
                self.table.items.update(snapshot)

    def test_a_device_deleted_meanwhile_is_not_recreated(self):
        image = self.ready_image(USER, [DP])
        self.device_client.before_transact = lambda t: t.items.pop((f"DEVICE#{DP}", "METADATA"))
        resp = self.set_profile(USER, DP, image)
        self.assertEqual(resp["statusCode"], 404, resp["body"])
        self.assertNotIn((f"DEVICE#{DP}", "METADATA"), self.table.items)


class ChangeAndRemoveProfileImageTests(ProfileImageTestCase):
    def test_changing_the_picture_keeps_both_images(self):
        first = self.ready_image(USER, [D1], name="first.png")
        second = self.ready_image(USER, [D1], name="second.png")
        self.assertEqual(self.set_profile(USER, D1, first)["statusCode"], 200)
        images_before = self.image_rows()
        resp = self.set_profile(MEMBER, D1, second)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        self.assertEqual(self.device_meta(D1)[FIELD], second)
        self.assertEqual(self.image_rows(), images_before)
        self.assertEqual(self.deleted, [])

    def test_removing_the_picture_keeps_the_image(self):
        image = self.ready_image(USER, [DP])
        self.set_profile(USER, DP, image)
        images_before = self.image_rows()
        for cleared in (None, ""):
            with self.subTest(cleared=cleared):
                resp = self.set_profile(USER, DP, cleared)
                self.assertEqual(resp["statusCode"], 200, resp["body"])
                self.assertNotIn(FIELD, response_body(resp))
                self.assertNotIn(FIELD, self.device_meta(DP))
                self.assertNotIn(FIELD, self.get_device(USER, DP))
        self.assertEqual(self.image_rows(), images_before)
        self.assertEqual(self.deleted, [])
        # Still in the device's gallery.
        listing = self.lam("artifacts-list").handler(base.event(
            USER, "/devices/{deviceId}/artifacts", path={"deviceId": DP}, query={"type": "image"}), None)
        self.assertEqual([a["artifactId"] for a in response_body(listing)["artifacts"]], [image])

    def test_other_device_edits_keep_the_picture_and_vice_versa(self):
        image = self.ready_image(USER, [DP])
        self.set_profile(USER, DP, image)
        resp = self.patch_device(USER, DP, {"description": "Bedside pump", "reverseEngineeringStatus": "in_progress"})
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        self.assertEqual(response_body(resp)[FIELD], image)
        self.assertEqual(self.device_meta(DP)[FIELD], image)
        # Setting the picture leaves the other fields alone.
        other = self.ready_image(USER, [DP], name="other.png")
        self.set_profile(USER, DP, other)
        meta = self.device_meta(DP)
        self.assertEqual((meta["description"], meta["reverseEngineeringStatus"], meta[FIELD]),
                         ("Bedside pump", "in_progress", other))

    def test_picture_and_rename_in_one_request(self):
        image = self.ready_image(USER, [D1])
        resp = self.patch_device(MEMBER, D1, {"name": "Infusion pump 1", FIELD: image})
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        body = response_body(resp)
        self.assertEqual((body["name"], body[FIELD]), ("Infusion pump 1", image))
        # The rename still reached the copies of the name (here, the image's device link).
        self.assertEqual(self.table.items[(f"ARTIFACT#{image}", f"DEVICE#{D1}")]["name"], "Infusion pump 1")

    def test_devices_without_a_picture_are_unchanged(self):
        self.assertNotIn(FIELD, self.get_device(USER, DP))
        self.assertNotIn(FIELD, self.list_devices(USER)[DP])
        self.assertTrue(all(FIELD not in d for d in self.list_devices(USER, W1).values()))


class ProfileImageLifecycleTests(ProfileImageTestCase):
    def test_replacing_the_file_keeps_the_picture_and_shows_the_new_file(self):
        image = self.ready_image(USER, [D1])
        self.set_profile(USER, D1, image)
        old_key = self.meta(image)["s3Key"]
        rid, _ = self.replace(MEMBER, image)
        # Same artifact, so the device still references it without being set again...
        self.assertEqual(self.device_meta(D1)[FIELD], image)
        self.assertEqual(self.get_device(MEMBER, D1)[FIELD], image)
        # ...and its view URL now serves the new file.
        self.assertEqual(self.view_key(MEMBER, image), f"artifacts/{image}/{rid}")
        self.assertIn(old_key, self.deleted)

    def test_a_stale_reference_is_harmless_and_can_be_cleared(self):
        image = self.ready_image(USER, [DP])
        self.set_profile(USER, DP, image)
        # The image stops being viewable (e.g. it's gone).
        del self.table.items[(f"ARTIFACT#{image}", "METADATA")]
        # Device reads still work and return the reference as stored...
        self.assertEqual(self.get_device(USER, DP)[FIELD], image)
        self.assertEqual(self.list_devices(USER)[DP][FIELD], image)
        # ...the view-URL endpoint reports it unavailable (the UI shows the placeholder)...
        [result] = self.view_results(USER, [image])
        self.assertEqual((result["ok"], result["status"]), (False, 404))
        # ...it can't be chosen again, and removing it works.
        self.assertEqual(self.set_profile(USER, DP, image)["statusCode"], 400)
        self.assertEqual(self.set_profile(USER, DP, None)["statusCode"], 200)
        self.assertNotIn(FIELD, self.device_meta(DP))

    def test_a_malformed_stored_reference_is_not_returned(self):
        self.device_meta(DP)[FIELD] = "garbage#value"
        self.assertNotIn(FIELD, self.get_device(USER, DP))
        self.assertNotIn(FIELD, self.list_devices(USER)[DP])


if __name__ == "__main__":
    unittest.main()
