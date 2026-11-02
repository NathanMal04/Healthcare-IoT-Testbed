"""Image replacement: POST /artifacts/{id}/replacement (artifacts-presign)
and POST /artifacts/{id}/replacement/complete (artifacts-complete), with
DynamoDB and S3 replaced by in-memory fakes.

A replacement keeps the artifact (id, title, description, capturedAt, tags,
devices, scope) and swaps only its file. The old file stays live until the new
one is verified and swapped in, and is then permanently deleted.

Uses the world of test_workspace_artifacts: W1 has USER (owner) and MEMBER,
W2 has W2_OWNER, OUTSIDER belongs to neither. D1 and D2 are W1 devices, DP is
USER's personal device.

    pip install boto3
    python -m unittest discover -s Platform/services/lambdas/tests
"""
import base64
import copy
import io
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError, EndpointConnectionError, ReadTimeoutError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_workspace_artifacts as base  # noqa: E402  (world, fakes and helpers)
import test_image_artifacts as images  # noqa: E402  (image fakes and helpers)

USER, MEMBER, W2_OWNER, OUTSIDER = base.USER, base.MEMBER, base.W2_OWNER, base.OUTSIDER
W1, D1, D2, DP = base.W1, base.D1, base.D2, base.DP
PNG, JPEG, WEBP, SVG = images.PNG, images.JPEG, images.WEBP, images.SVG
event, response_body = base.event, base.response_body

NEW_SHA = "b" * 64
OTHER_SHA = "c" * 64
UNKNOWN = "0192a000-0000-7000-8000-0000000000ff"


def _failed():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}}, "UpdateItem")


def _rep(item):
    return (item or {}).get("replacement") or {}


# The conditional writes of the replacement flow, evaluated on the fake.
REPLACEMENT_CONDITIONS = {
    # artifacts-presign: start (nothing pending, or superseding the one seen)
    "attemptId = :expected AND #st = :ready AND #type = :image AND attribute_not_exists(#rep)":
        lambda i, v: i is not None and i.get("attemptId") == v[":expected"] and i.get("status") == "ready"
        and i.get("type") == "image" and "replacement" not in i,
    "attemptId = :expected AND #st = :ready AND #type = :image AND #rep.#rid = :previous":
        lambda i, v: i is not None and i.get("attemptId") == v[":expected"] and i.get("status") == "ready"
        and i.get("type") == "image" and _rep(i).get("replacementId") == v[":previous"],
    # artifacts-complete: swap, abandon, track an orphan, clean up
    "attemptId = :expected AND #st = :ready AND #rep.#rid = :rid":
        lambda i, v: i is not None and i.get("attemptId") == v[":expected"] and i.get("status") == "ready"
        and _rep(i).get("replacementId") == v[":rid"],
    "#rep.#rid = :rid":
        lambda i, v: i is not None and _rep(i).get("replacementId") == v[":rid"],
    "attribute_exists(pk) AND attemptId <> :rid AND (attribute_not_exists(#rep) OR #rep.#rid <> :rid)":
        lambda i, v: i is not None and i.get("attemptId") != v[":rid"]
        and _rep(i).get("replacementId") != v[":rid"],
    "attribute_exists(pk)": lambda i, v: i is not None,
}

CLAUSES = re.compile(r"(?:^|\s)(SET|REMOVE|ADD|DELETE)\s")


class ReplacementTable(images.ImageTable):
    """ImageTable plus the update expressions the replacement flow uses:
    SET, REMOVE, ADD and DELETE on string sets, and the replacement map."""

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None,
                    ExpressionAttributeNames=None, ReturnValues=None):
        if ConditionExpression not in REPLACEMENT_CONDITIONS:
            return super().update_item(Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression,
                                       ExpressionAttributeNames, ReturnValues)
        self.updates.append((Key, UpdateExpression))
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues
        item = self.items.get((Key["pk"], Key["sk"]))
        if not REPLACEMENT_CONDITIONS[ConditionExpression](copy.deepcopy(item), values):
            raise _failed()
        parts = CLAUSES.split(UpdateExpression)
        for action, body in zip(parts[1::2], parts[2::2]):
            for clause in body.strip().split(", "):
                if action == "SET":
                    attr, value = clause.split(" = ")
                    item[names.get(attr, attr)] = copy.deepcopy(values[value])
                elif action == "REMOVE":
                    item.pop(names.get(clause, clause), None)
                elif action == "ADD":
                    attr, value = clause.split(" ")
                    item[attr] = set(item.get(attr) or ()) | set(values[value])
                else:  # DELETE: an emptied set disappears, as in DynamoDB
                    attr, value = clause.split(" ")
                    remaining = set(item.get(attr) or ()) - set(values[value])
                    if remaining:
                        item[attr] = remaining
                    else:
                        item.pop(attr, None)
        return {"Attributes": copy.deepcopy(item)}


class ReplacementTestCase(images.ImageTestCase):
    def setUp(self):
        super().setUp()
        self.table = ReplacementTable(base.world())
        self.client = base.FakeClient(self.table)
        self.objects = {}  # replacement uploads: s3Key -> {data, contentType, sha256, size}
        self.deleted = []
        self.delete_errors = {}  # s3Key -> exception raised by delete_object
        self.head_hook = None  # called with the key during HeadObject

    def lam(self, name):
        module = super().lam(name)
        if name == "artifacts-complete" and not getattr(module, "_replacement_fakes", False):
            module._replacement_fakes = True
            module.s3.delete_object.side_effect = self._delete_object
        return module

    # --- S3 fakes ---

    def _head_object(self, Bucket, Key, ChecksumMode=None):
        if self.head_hook:
            hook, self.head_hook = self.head_hook, None
            hook(Key)
        if Key not in self.objects:
            live = any(v.get("s3Key") == Key for (_, sk), v in self.table.items.items() if sk == "METADATA")
            if Key in self.deleted or not live:
                raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
            return super()._head_object(Bucket, Key, ChecksumMode)
        obj = self.objects[Key]
        return {"ContentLength": obj["size"], "ContentType": obj["contentType"],
                "ChecksumSHA256": base64.b64encode(bytes.fromhex(obj["sha256"])).decode()}

    def _get_object(self, Bucket, Key, Range=None):
        if Key in self.objects:
            self.ranges.append(Range)
            return {"Body": io.BytesIO(self.objects[Key]["data"])}
        return super()._get_object(Bucket, Key, Range)

    def _delete_object(self, Bucket, Key):
        if Key in self.delete_errors:
            raise self.delete_errors[Key]
        self.deleted.append(Key)
        self.objects.pop(Key, None)
        self.stored_bytes.pop(Key, None)
        return {}

    # --- helpers ---

    def start(self, user, artifact_id, expected=None, **overrides):
        body = {"originalFilename": "board-v2.jpg", "sizeBytes": 2000, "sha256": NEW_SHA,
                "mimeType": "image/jpeg"}
        if artifact_id in {k[0][len("ARTIFACT#"):] for k in self.table.items}:
            body["expectedAttemptId"] = expected or self.meta(artifact_id)["attemptId"]
        body.update(overrides)
        body = {k: v for k, v in body.items() if v is not None}
        return self.lam("artifacts-presign").handler(
            event(user, "/artifacts/{artifactId}/replacement", body=body, path={"artifactId": artifact_id}), None)

    def started(self, user, artifact_id, **overrides):
        resp = self.start(user, artifact_id, **overrides)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return response_body(resp)["replacementId"]

    def upload(self, artifact_id, replacement_id, data=JPEG, **overrides):
        """What the presigned POST stores: the declared type, size and checksum."""
        rep = self.meta(artifact_id).get("replacement") or {}
        key = f"artifacts/{artifact_id}/{replacement_id}"
        self.objects[key] = {"data": data, "contentType": rep.get("mimeType", "image/jpeg"),
                             "sha256": rep.get("sha256", NEW_SHA), "size": int(rep.get("sizeBytes", 2000)),
                             **overrides}
        return key

    def finish(self, user, artifact_id, replacement_id):
        return self.lam("artifacts-complete").handler(
            event(user, "/artifacts/{artifactId}/replacement/complete", body={"replacementId": replacement_id},
                  path={"artifactId": artifact_id}), None)

    def finished(self, user, artifact_id, replacement_id):
        resp = self.finish(user, artifact_id, replacement_id)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return response_body(resp)

    def replace(self, user, artifact_id, data=JPEG, **overrides):
        rid = self.started(user, artifact_id, **overrides)
        self.upload(artifact_id, rid, data)
        return rid, self.finished(user, artifact_id, rid)

    def upload_pcap(self):
        """A ready pcap artifact (not an image)."""
        resp = self.presign(USER, [self.file(artifact_type="pcap")], deviceIds=[DP])
        aid = response_body(resp)["results"][0]["artifactId"]
        self.meta(aid)["status"] = "ready"
        return aid

    def tags_set_on(self, key):
        complete = self.lam("artifacts-complete")
        return [c.kwargs["Tagging"]["TagSet"][0]["Value"] for c in complete.s3.put_object_tagging.call_args_list
                if c.kwargs["Key"] == key]

    def view_key(self, user, artifact_id):
        get = self.lam("artifacts-get")
        get.s3.generate_presigned_url.reset_mock()
        [result] = self.view_results(user, [artifact_id])
        self.assertTrue(result["ok"], result)
        return get.s3.generate_presigned_url.call_args.kwargs["Params"]["Key"]


# --- Start ---------------------------------------------------------------------------


class ReplacementStartTests(ReplacementTestCase):
    def test_start_records_the_replacement_and_keeps_the_live_image(self):
        aid = self.ready_image(USER, [DP])
        before = copy.deepcopy(self.meta(aid))
        resp = self.start(USER, aid)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        body = response_body(resp)
        rid = body["replacementId"]
        self.assertEqual(body["artifactId"], aid)
        self.assertEqual(body["upload"]["mode"], "single")

        meta = self.meta(aid)
        new_key = f"artifacts/{aid}/{rid}"
        self.assertEqual(meta["replacement"]["s3Key"], new_key)
        self.assertEqual((meta["replacement"]["sha256"], meta["replacement"]["sizeBytes"],
                          meta["replacement"]["mimeType"], meta["replacement"]["requestedBy"]),
                         (NEW_SHA, 2000, "image/jpeg", USER))
        # Until it's completed, the artifact is exactly what it was.
        self.assertEqual({k: v for k, v in meta.items() if k != "replacement"}, before)
        self.assertEqual(self.view_key(USER, aid), before["s3Key"])

        # The presigned POST pins the new key, type, exact size, checksum and pending tag.
        post = self.lam("artifacts-presign").s3.generate_presigned_post.call_args.kwargs
        self.assertEqual(post["Key"], new_key)
        self.assertEqual(post["Fields"]["Content-Type"], "image/jpeg")
        self.assertIn(["content-length-range", 2000, 2000], post["Conditions"])
        self.assertEqual(post["Fields"]["x-amz-checksum-sha256"],
                         base64.b64encode(bytes.fromhex(NEW_SHA)).decode())
        self.assertIn("pending", post["Fields"]["tagging"])

    def test_authorization_matches_patch(self):
        personal = self.ready_image(USER, [DP], name="p.png")
        workspace = self.ready_image(USER, [D1], name="w.png")
        for user, aid in ((MEMBER, personal), (OUTSIDER, personal), (W2_OWNER, personal),
                          (OUTSIDER, workspace), (W2_OWNER, workspace)):
            with self.subTest(user=user, aid=aid):
                resp = self.start(user, aid)
                self.assertEqual(resp["statusCode"], 404, resp["body"])
                self.assertNotIn("replacement", self.meta(aid))
        # Any member of the workspace, like PATCH.
        self.assertEqual(self.start(MEMBER, workspace)["statusCode"], 200)

    def test_requests_that_are_refused(self):
        aid = self.ready_image(USER, [DP])
        cases = [
            ({"mimeType": "image/svg+xml"}, 400, "mimeType must be one of"),
            ({"mimeType": "image/gif"}, 400, "mimeType must be one of"),
            ({"sizeBytes": 25 * 1024 ** 2 + 1}, 400, "at most 26214400 bytes"),
            ({"sizeBytes": 0}, 400, "positive integer"),
            ({"sizeBytes": True}, 400, "positive integer"),
            ({"sha256": "XYZ"}, 400, "sha256"),
            ({"originalFilename": "  "}, 400, "originalFilename is required"),
            ({"originalFilename": "bad\x00.png"}, 400, "originalFilename is invalid"),
            ({"title": "New title"}, 400, "Unsupported field(s): title"),
            ({"deviceIds": [D1]}, 400, "Unsupported field(s): deviceIds"),
            ({"expectedAttemptId": ""}, 400, "expectedAttemptId is required"),
            ({"expectedAttemptId": "old-attempt"}, 409, "has changed since it was loaded"),
        ]
        for overrides, status, message in cases:
            with self.subTest(overrides=overrides):
                resp = self.start(USER, aid, **overrides)
                self.assertEqual(resp["statusCode"], status, resp["body"])
                self.assertIn(message, response_body(resp)["error"])
        self.assertNotIn("replacement", self.meta(aid))

    def test_only_ready_images_can_be_replaced(self):
        pcap = self.upload_pcap()
        resp = self.start(USER, pcap)
        self.assertEqual((resp["statusCode"], response_body(resp)["error"]),
                         (400, "Only image artifacts can be replaced"))
        pending = self.presign_one(USER, self.image(name="pending.png"), [DP])["artifactId"]
        resp = self.start(USER, pending)
        self.assertEqual(resp["statusCode"], 409, resp["body"])
        self.assertEqual(self.start(USER, UNKNOWN, expectedAttemptId="x")["statusCode"], 404)
        bad = self.lam("artifacts-presign").handler(
            event(USER, "/artifacts/{artifactId}/replacement", body={}, path={"artifactId": "nope"}), None)
        self.assertEqual(bad["statusCode"], 400)

    def test_a_new_start_supersedes_an_unfinished_one(self):
        aid = self.ready_image(USER, [DP])
        live_key = self.meta(aid)["s3Key"]
        first = self.started(USER, aid)
        self.upload(aid, first)
        second = self.started(USER, aid, originalFilename="better.png",
                              mimeType="image/png", sha256=OTHER_SHA)
        meta = self.meta(aid)
        self.assertEqual(meta["replacement"]["replacementId"], second)
        self.assertEqual(meta["orphanS3Keys"], {f"artifacts/{aid}/{first}"})

        # The superseded upload can't be completed, and its object is deleted.
        resp = self.finish(USER, aid, first)
        self.assertEqual(resp["statusCode"], 409, resp["body"])
        self.assertIn("no longer current", response_body(resp)["error"])
        self.assertEqual(self.meta(aid)["s3Key"], live_key)

        self.upload(aid, second, PNG)
        done = self.finished(USER, aid, second)
        self.assertFalse(done["cleanupPending"])
        self.assertCountEqual(self.deleted, [f"artifacts/{aid}/{first}", live_key])
        self.assertNotIn("orphanS3Keys", self.meta(aid))

    def test_concurrent_starts_cannot_both_win(self):
        aid = self.ready_image(USER, [DP])
        first = self.started(USER, aid)
        # A second request whose read didn't see the first replacement yet.
        presign = self.lam("artifacts-presign")
        real = presign.testbed_authz.require_resource

        def stale_read(*args, **kwargs):
            item = real(*args, **kwargs)
            item.pop("replacement", None)
            return item

        with mock.patch.object(presign.testbed_authz, "require_resource", side_effect=stale_read):
            resp = self.start(USER, aid)
        self.assertEqual(resp["statusCode"], 409, resp["body"])
        self.assertEqual(self.meta(aid)["replacement"]["replacementId"], first)
        self.assertNotIn("orphanS3Keys", self.meta(aid))

    def test_a_replaced_image_needs_its_new_attempt_id(self):
        aid = self.ready_image(USER, [DP])
        old_attempt = self.meta(aid)["attemptId"]
        rid, _ = self.replace(USER, aid)
        resp = self.start(USER, aid, expected=old_attempt)
        self.assertEqual(resp["statusCode"], 409)
        self.assertEqual(self.start(USER, aid, expected=rid)["statusCode"], 200)


# --- Complete ------------------------------------------------------------------------


class ReplacementCompleteTests(ReplacementTestCase):
    def workspace_image(self):
        resp = self.presign(USER, [self.image(name="board.png", title="Main board", description="Top side",
                                              capturedAt="2024-03-02")],
                            deviceIds=[D1, D2], tags=["teardown", "uart"])
        aid = response_body(resp)["results"][0]["artifactId"]
        done = self.complete(USER, aid, PNG)
        self.assertEqual(done["status"], "ready")
        return aid

    def test_replacement_swaps_the_file_and_keeps_everything_else(self):
        aid = self.workspace_image()
        before = copy.deepcopy(self.meta(aid))
        other_rows = {k: copy.deepcopy(v) for k, v in self.table.items.items() if k[1] != "METADATA"}

        rid = self.started(MEMBER, aid, originalFilename="board-hires.jpg")
        new_key = self.upload(aid, rid, JPEG)
        body = self.finished(MEMBER, aid, rid)

        meta = self.meta(aid)
        self.assertEqual((meta["s3Key"], meta["attemptId"], meta["sha256"], meta["sizeBytes"], meta["mimeType"],
                          meta["originalFilename"]),
                         (new_key, rid, NEW_SHA, 2000, "image/jpeg", "board-hires.jpg"))
        kept = ("artifactId", "name", "type", "title", "description", "capturedAt", "tags", "deviceIds",
                "workspaceId", "createdAt", "createdBy", "uploadBatchId", "status", "s3Bucket", "uploadMode")
        self.assertEqual({k: meta.get(k) for k in kept}, {k: before.get(k) for k in kept})
        self.assertNotEqual(meta["uploadedAt"], before.get("uploadedAt") or "")
        self.assertNotIn("replacement", meta)
        self.assertNotIn("orphanS3Keys", meta)
        # No second artifact, no changed links.
        self.assertEqual({k: v for k, v in self.table.items.items() if k[1] != "METADATA"}, other_rows)
        self.assertEqual(sum(1 for (pk, sk) in self.table.items if pk.startswith("ARTIFACT#") and sk == "METADATA"),
                         1)

        # The old object is gone for good; the new one is committed.
        self.assertEqual(self.deleted, [before["s3Key"]])
        self.assertEqual(self.tags_set_on(new_key), ["committed"])
        self.assertEqual(body["image"]["attemptId"], rid)
        self.assertEqual((body["image"]["title"], body["image"]["description"], body["image"]["capturedAt"],
                          body["image"]["mimeType"], body["image"]["originalFilename"]),
                         ("Main board", "Top side", "2024-03-02", "image/jpeg", "board-hires.jpg"))
        self.assertFalse(body["cleanupPending"])

        # New view and download URLs use the new file; the listing still has one image.
        self.assertEqual(self.view_key(USER, aid), new_key)
        listed = response_body(self.lam("artifacts-list").handler(
            event(USER, "/devices/{deviceId}/artifacts", path={"deviceId": D1}, query={"type": "image"}), None))["artifacts"]
        self.assertEqual([a["artifactId"] for a in listed], [aid])
        self.assertEqual(listed[0]["sha256"], NEW_SHA)

    def test_repeating_a_completed_replacement_is_safe(self):
        aid = self.ready_image(USER, [DP])
        rid, first = self.replace(USER, aid)
        deleted = list(self.deleted)
        again = self.finished(USER, aid, rid)
        self.assertEqual(again["image"], first["image"])
        self.assertEqual(self.deleted, deleted)  # nothing more deleted, the live file least of all
        self.assertEqual(self.meta(aid)["s3Key"], f"artifacts/{aid}/{rid}")

    def test_failed_verification_keeps_the_current_image(self):
        tampered = [
            ("svg", {"data": SVG}, "not a valid image/jpeg image"),
            ("html", {"data": b"<!doctype html><script>x</script>"}, "not a valid image/jpeg image"),
            ("png bytes", {"data": PNG}, "not a valid image/jpeg image"),
            ("content type", {"contentType": "text/html"}, "not stored as image/jpeg"),
            ("checksum", {"sha256": OTHER_SHA}, "declared size and SHA-256"),
            ("size", {"size": 1999}, "declared size and SHA-256"),
        ]
        for label, overrides, message in tampered:
            with self.subTest(label):
                aid = self.ready_image(USER, [DP], name=f"{label}.png")
                before = copy.deepcopy(self.meta(aid))
                rid = self.started(USER, aid)
                data = overrides.pop("data", JPEG)
                bad_key = self.upload(aid, rid, data, **overrides)
                resp = self.finish(USER, aid, rid)
                self.assertEqual(resp["statusCode"], 422, resp["body"])
                self.assertIn(message, response_body(resp)["error"])
                self.assertIn("current image was kept", response_body(resp)["error"])

                meta = self.meta(aid)
                self.assertEqual({k: v for k, v in meta.items() if k not in ("replacement", "orphanS3Keys")},
                                 before)
                self.assertNotIn("replacement", meta)
                self.assertNotIn(before["s3Key"], self.deleted)  # the live file is untouched
                self.assertIn(bad_key, self.deleted)  # the rejected upload is removed
                self.assertNotIn("committed", self.tags_set_on(bad_key))
                self.assertEqual(self.view_key(USER, aid), before["s3Key"])
                # It can't be completed later either.
                self.assertEqual(self.finish(USER, aid, rid)["statusCode"], 409)

    def test_upload_not_landed_yet_can_be_completed_later(self):
        aid = self.ready_image(USER, [DP])
        live_key = self.meta(aid)["s3Key"]
        rid = self.started(USER, aid)
        resp = self.finish(USER, aid, rid)  # interrupted: the POST never reached S3
        self.assertEqual(resp["statusCode"], 409, resp["body"])
        self.assertIn("not found yet", response_body(resp)["error"])
        self.assertEqual(self.meta(aid)["replacement"]["replacementId"], rid)
        self.assertEqual((self.meta(aid)["s3Key"], self.deleted), (live_key, []))
        self.upload(aid, rid)
        self.assertEqual(self.finished(USER, aid, rid)["image"]["attemptId"], rid)

    def test_transient_s3_errors_change_nothing(self):
        aid = self.ready_image(USER, [DP])
        before = copy.deepcopy(self.meta(aid))
        rid = self.started(USER, aid)
        self.upload(aid, rid)
        complete = self.lam("artifacts-complete")
        errors = [
            ("head", ClientError({"Error": {"Code": "SlowDown", "Message": "x"}}, "HeadObject")),
            ("head", EndpointConnectionError(endpoint_url="https://s3")),
            ("get", ClientError({"Error": {"Code": "InternalError", "Message": "x"}}, "GetObject")),
            ("get", ReadTimeoutError(endpoint_url="https://s3")),
        ]
        for where, error in errors:
            with self.subTest(where=where, error=type(error).__name__):
                target = complete.s3.head_object if where == "head" else complete.s3.get_object
                original, target.side_effect = target.side_effect, error
                try:
                    resp = self.finish(USER, aid, rid)
                finally:
                    target.side_effect = original
                self.assertEqual(resp["statusCode"], 409, resp["body"])
                meta = self.meta(aid)
                self.assertEqual((meta["s3Key"], meta["replacement"]["replacementId"]), (before["s3Key"], rid))
                self.assertEqual(self.deleted, [])
        self.finished(USER, aid, rid)

    def test_superseded_during_verification_never_goes_live(self):
        aid = self.ready_image(USER, [DP])
        live_key = self.meta(aid)["s3Key"]
        first = self.started(USER, aid)
        first_key = self.upload(aid, first)
        later = {}
        # Another member starts a newer replacement while the first is checked.
        self.head_hook = lambda key: later.setdefault("rid", self.started(USER, aid, sha256=OTHER_SHA))
        resp = self.finish(USER, aid, first)
        self.assertEqual(resp["statusCode"], 409, resp["body"])
        meta = self.meta(aid)
        self.assertEqual(meta["s3Key"], live_key)
        self.assertEqual(meta["replacement"]["replacementId"], later["rid"])
        self.assertEqual(self.deleted, [first_key])  # the never-live upload, not the live file
        self.assertNotIn("orphanS3Keys", meta)

        self.upload(aid, later["rid"])
        self.finished(USER, aid, later["rid"])
        self.assertEqual(self.deleted, [first_key, live_key])

    def test_concurrent_completions_of_one_replacement(self):
        aid = self.ready_image(USER, [DP])
        live_key = self.meta(aid)["s3Key"]
        rid = self.started(USER, aid)
        new_key = self.upload(aid, rid)
        inner = {}
        # A second completion request finishes first, during the first one's check.
        self.head_hook = lambda key: inner.setdefault("resp", self.finish(USER, aid, rid))
        outer = self.finished(USER, aid, rid)
        self.assertEqual(inner["resp"]["statusCode"], 200, inner["resp"]["body"])
        self.assertEqual(outer["image"]["attemptId"], rid)
        self.assertEqual(self.meta(aid)["s3Key"], new_key)
        self.assertNotIn(new_key, self.deleted)
        self.assertEqual(self.deleted, [live_key])

    def test_failed_deletion_is_tracked_tagged_for_expiry_and_retried(self):
        for error in (ClientError({"Error": {"Code": "InternalError", "Message": "x"}}, "DeleteObject"),
                      EndpointConnectionError(endpoint_url="https://s3")):
            with self.subTest(error=type(error).__name__):
                aid = self.ready_image(USER, [DP], name=f"{type(error).__name__}.png")
                old_key = self.meta(aid)["s3Key"]
                self.delete_errors[old_key] = error
                rid, body = self.replace(USER, aid)
                self.assertTrue(body["cleanupPending"])
                meta = self.meta(aid)
                # The replacement succeeded; the old key isn't lost.
                self.assertEqual(meta["s3Key"], f"artifacts/{aid}/{rid}")
                self.assertEqual(meta["orphanS3Keys"], {old_key})
                self.assertEqual(self.tags_set_on(old_key)[-1], "pending")

                del self.delete_errors[old_key]
                again = self.finished(USER, aid, rid)
                self.assertFalse(again["cleanupPending"])
                self.assertIn(old_key, self.deleted)
                self.assertNotIn("orphanS3Keys", self.meta(aid))

    def failing_cleanup_writes(self):
        """DynamoDB throttles the cleanup's own writes (removing a deleted key)."""
        real = self.table.update_item

        def update_item(**kwargs):
            if kwargs["UpdateExpression"].startswith("DELETE orphanS3Keys"):
                raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
                                  "UpdateItem")
            return real(**kwargs)

        return mock.patch.object(self.table, "update_item", side_effect=update_item)

    def test_a_cleanup_failure_after_the_swap_still_reports_success(self):
        aid = self.ready_image(USER, [DP])
        old_key = self.meta(aid)["s3Key"]
        rid = self.started(USER, aid)
        new_key = self.upload(aid, rid)
        with self.failing_cleanup_writes():
            resp = self.finish(USER, aid, rid)
        # The file was replaced: the answer must say so, not 500.
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        body = response_body(resp)
        self.assertTrue(body["cleanupPending"])
        self.assertEqual(body["image"]["attemptId"], rid)
        meta = self.meta(aid)
        self.assertEqual(meta["s3Key"], new_key)
        self.assertEqual(meta["orphanS3Keys"], {old_key})  # still tracked
        # A later call finishes the cleanup.
        again = self.finished(USER, aid, rid)
        self.assertFalse(again["cleanupPending"])
        self.assertNotIn("orphanS3Keys", self.meta(aid))
        self.assertNotIn(new_key, self.deleted)

    def test_a_cleanup_failure_after_the_swap_survives_a_failed_reread(self):
        aid = self.ready_image(USER, [DP])
        rid = self.started(USER, aid)
        self.upload(aid, rid)
        complete = self.lam("artifacts-complete")
        reads = {"n": 0}

        def flaky_read(table, key):
            reads["n"] += 1
            if reads["n"] > 1:  # every read after the first: the cleanup's and the final re-read
                raise ClientError({"Error": {"Code": "InternalServerError", "Message": "x"}}, "GetItem")
            return table.get_item(Key=key, ConsistentRead=True).get("Item")

        with mock.patch.object(complete, "_read", side_effect=flaky_read):
            resp = self.finish(USER, aid, rid)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        body = response_body(resp)
        self.assertEqual((body["image"]["attemptId"], body["cleanupPending"]), (rid, True))
        self.assertEqual(self.meta(aid)["s3Key"], f"artifacts/{aid}/{rid}")

    def test_a_cleanup_failure_never_hides_the_real_error(self):
        aid = self.ready_image(USER, [DP])
        live_key = self.meta(aid)["s3Key"]
        rid = self.started(USER, aid)
        bad_key = self.upload(aid, rid, SVG)
        with self.failing_cleanup_writes():
            resp = self.finish(USER, aid, rid)
        self.assertEqual(resp["statusCode"], 422, resp["body"])
        self.assertIn("current image was kept", response_body(resp)["error"])
        meta = self.meta(aid)
        self.assertEqual(meta["s3Key"], live_key)
        self.assertEqual(meta["orphanS3Keys"], {bad_key})  # still tracked for the next call
        self.assertNotIn(live_key, self.deleted)

    def test_a_later_replacement_retries_earlier_cleanup(self):
        aid = self.ready_image(USER, [DP])
        first_key = self.meta(aid)["s3Key"]
        self.delete_errors[first_key] = ClientError({"Error": {"Code": "InternalError", "Message": "x"}},
                                                    "DeleteObject")
        rid, _ = self.replace(USER, aid)
        del self.delete_errors[first_key]
        _, body = self.replace(USER, aid, expected=rid, sha256=OTHER_SHA)
        self.assertFalse(body["cleanupPending"])
        self.assertCountEqual(self.deleted, [first_key, f"artifacts/{aid}/{rid}"])

    def test_cleanup_never_deletes_live_pending_or_foreign_keys(self):
        aid = self.ready_image(USER, [DP])
        other = self.ready_image(USER, [DP], name="other.png")
        rid, _ = self.replace(USER, aid)
        pending = self.started(USER, aid)
        meta = self.meta(aid)
        protected = {meta["s3Key"], meta["replacement"]["s3Key"], self.meta(other)["s3Key"],
                     "devices/x/firmware/fw.bin"}
        meta["orphanS3Keys"] = set(protected)
        self.deleted.clear()
        self.finished(USER, aid, rid)  # a repeated completion runs the cleanup
        self.assertEqual(self.deleted, [])
        self.assertEqual(self.meta(aid)["replacement"]["replacementId"], pending)

    def test_an_orphan_is_only_recorded_when_it_cannot_go_live(self):
        # Even from a stale read: the write itself checks the replacement
        # is neither live nor pending.
        aid = self.ready_image(USER, [DP])
        rid = self.started(USER, aid)
        complete = self.lam("artifacts-complete")
        key = {"pk": f"ARTIFACT#{aid}", "sk": "METADATA"}
        complete._add_orphan(self.table, key, f"artifacts/{aid}/{rid}", rid)
        complete._add_orphan(self.table, key, self.meta(aid)["s3Key"], self.meta(aid)["attemptId"])
        self.assertNotIn("orphanS3Keys", self.meta(aid))

    def test_completion_authorization_and_validation(self):
        personal = self.ready_image(USER, [DP], name="p.png")
        workspace = self.ready_image(USER, [D1], name="w.png")
        for aid in (personal, workspace):
            rid = self.started(USER, aid)
            self.upload(aid, rid)
            before = copy.deepcopy(self.meta(aid))
            users = (MEMBER, OUTSIDER, W2_OWNER) if aid == personal else (OUTSIDER, W2_OWNER)
            for user in users:
                with self.subTest(aid=aid, user=user):
                    resp = self.finish(user, aid, rid)
                    self.assertEqual(resp["statusCode"], 404, resp["body"])
                    self.assertEqual(self.meta(aid), before)
            self.assertEqual(self.deleted, [])
        # Any member of the workspace may complete it.
        self.assertEqual(self.finish(MEMBER, workspace, self.meta(workspace)["replacement"]["replacementId"])
                         ["statusCode"], 200)

        self.assertEqual(self.finish(USER, personal, "not-a-uuid")["statusCode"], 400)
        self.assertEqual(self.finish(USER, UNKNOWN, UNKNOWN)["statusCode"], 404)
        pcap = self.upload_pcap()
        self.assertEqual(self.finish(USER, pcap, UNKNOWN)["statusCode"], 400)

    def test_batch_completion_is_unchanged(self):
        aid = self.ready_image(USER, [DP])
        rid = self.started(USER, aid)
        self.upload(aid, rid)
        # The batch endpoint knows nothing of replacements: the image is ready.
        result = self.lam("artifacts-complete").handler(
            event(USER, "/artifacts/complete", body={"items": [{"artifactId": aid, "attemptId": rid}]}), None)
        [item] = response_body(result)["results"]
        self.assertEqual((item["ok"], item["status"]), (False, 409))
        self.assertEqual(self.meta(aid)["replacement"]["replacementId"], rid)


if __name__ == "__main__":
    unittest.main()
