"""Image artifacts (Device Image Management, Phase 1): type = image uploads
through the existing presign/complete pipeline, the file signature and
MIME checks, image metadata editing (PATCH /artifacts/{id}), inline view URLs
(POST /artifacts/view-urls) and device/scope listings, with DynamoDB and S3
replaced by in-memory fakes.

Uses the world of test_workspace_artifacts: W1 has USER (owner) and MEMBER,
W2 has W2_OWNER, OUTSIDER belongs to neither. D1 and D2 are W1 devices, D3 is
a W2 device, DP is USER's personal device.

    pip install boto3
    python -m unittest discover -s Platform/services/lambdas/tests
"""
import base64
import copy
import io
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError, ReadTimeoutError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_workspace_artifacts as base  # noqa: E402  (world, fakes and helpers)
import image_fields  # noqa: E402  (on the path through test_workspace_artifacts)

USER, MEMBER, W2_OWNER, OUTSIDER = base.USER, base.MEMBER, base.W2_OWNER, base.OUTSIDER
W1, W2, D1, D2, D3, DP = base.W1, base.W2, base.D1, base.D2, base.D3, base.DP
SHA = base.SHA
event, response_body, add_rows = base.event, base.response_body, base.add_rows

MIB = 1024 ** 2
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01"
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 "
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
HTML = b"<!doctype html><script>alert(1)</script>"
MISSING = "0192a000-0000-7000-8000-0000000000ff"


def _failed():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}}, "UpdateItem")


# The conditional updates the artifact Lambdas send, evaluated on the fake.
UPDATE_CONDITIONS = {
    # artifacts-complete _transition / _mark_failed
    "attemptId = :expected AND #st = :from":
        lambda i, v, n: i is not None and i.get("attemptId") == v[":expected"] and i.get(n["#st"]) == v[":from"],
    "attemptId = :expected AND #st = :pending":
        lambda i, v, n: i is not None and i.get("attemptId") == v[":expected"] and i.get(n["#st"]) == "pending",
    # artifacts-presign retry (the stale "verifying" case isn't exercised here)
    "attemptId = :expected AND (#st IN (:pending, :failed) "
    "OR (#st = :verifying AND statusUpdatedAt < :stale_before))":
        lambda i, v, n: i is not None and i.get("attemptId") == v[":expected"]
        and i.get(n["#st"]) in ("pending", "failed"),
    # artifacts-update
    "attribute_exists(pk) AND #type = :firmware":
        lambda i, v, n: i is not None and i.get(n["#type"]) == "firmware",
    "attribute_exists(pk) AND #type = :image":
        lambda i, v, n: i is not None and i.get(n["#type"]) == "image",
}


class ImageTable(base.FakeTable):
    """test_workspace_artifacts' table, plus generic SET/REMOVE updates and
    DynamoDB-style pagination (Limit, LastEvaluatedKey, ExclusiveStartKey)."""

    def __init__(self, rows):
        super().__init__(rows)
        self.updates = []

    def query(self, KeyConditionExpression, ScanIndexForward=True, Limit=None, ExclusiveStartKey=None):
        pk_cond, sk_cond = KeyConditionExpression.get_expression()["values"]
        pk = pk_cond.get_expression()["values"][1]
        prefix = sk_cond.get_expression()["values"][1]
        self.queries.append((pk, prefix))
        rows = sorted((copy.deepcopy(v) for (p, s), v in self.items.items() if p == pk and s.startswith(prefix)),
                      key=lambda r: r["sk"], reverse=not ScanIndexForward)
        if ExclusiveStartKey:
            after = [r["sk"] for r in rows].index(ExclusiveStartKey["sk"]) + 1
            rows = rows[after:]
        result = {"Items": rows[:Limit] if Limit else rows}
        if Limit and len(rows) > Limit:
            last = rows[Limit - 1]
            result["LastEvaluatedKey"] = {"pk": last["pk"], "sk": last["sk"]}
        return result

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None,
                    ExpressionAttributeNames=None, ReturnValues=None):
        if UpdateExpression.startswith("ADD "):
            return super().update_item(Key, UpdateExpression, ExpressionAttributeValues)
        self.updates.append((Key, UpdateExpression))
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues
        item = self.items.get((Key["pk"], Key["sk"]))
        if not UPDATE_CONDITIONS[ConditionExpression](item, values, names):
            raise _failed()
        set_part, _, remove_part = UpdateExpression.partition(" REMOVE ")
        assert set_part.startswith("SET "), UpdateExpression
        for assignment in set_part[len("SET "):].split(", "):
            attr, value = assignment.split(" = ")
            item[names.get(attr, attr)] = values[value]
        for attr in filter(None, remove_part.split(", ")):
            item.pop(names.get(attr, attr), None)
        return {"Attributes": copy.deepcopy(item)}


class ImageTestCase(base.WorldTestCase):
    def setUp(self):
        self.table = ImageTable(base.world())
        self.client = base.FakeClient(self.table)
        self.modules = {}
        self.stored_bytes = {}  # s3Key -> object bytes for artifacts-complete

    def lam(self, name):
        module = super().lam(name)
        if name == "artifacts-complete" and not getattr(module, "_image_fakes", False):
            module._image_fakes = True
            module.s3.head_object.side_effect = self._head_object
            module.s3.get_object.side_effect = self._get_object
            module.lambda_client = mock.Mock()
        return module

    # --- S3 fakes for artifacts-complete ---

    def _head_object(self, Bucket, Key, ChecksumMode=None):
        meta = self._meta_for_key(Key)
        return {
            "ContentLength": int(meta["sizeBytes"]),
            "ChecksumSHA256": base64.b64encode(bytes.fromhex(meta["sha256"])).decode(),
            "ContentType": self.content_types.get(Key, meta.get("mimeType", "application/octet-stream")),
        }

    def _get_object(self, Bucket, Key, Range=None):
        self.ranges.append(Range)
        return {"Body": io.BytesIO(self.stored_bytes[Key])}

    def _meta_for_key(self, key):
        return next(v for (pk, sk), v in self.table.items.items() if sk == "METADATA" and v.get("s3Key") == key)

    @property
    def content_types(self):
        return self.__dict__.setdefault("_content_types", {})

    @property
    def ranges(self):
        return self.__dict__.setdefault("_ranges", [])

    # --- helpers ---

    def image(self, name="board.png", mime="image/png", size=1000, **fields):
        return {"clientRef": name, "originalFilename": name, "sizeBytes": size, "sha256": SHA,
                "type": "image", "mimeType": mime, **fields}

    def presign_one(self, user, spec, device_ids):
        resp = self.presign(user, [spec], deviceIds=device_ids)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        [result] = response_body(resp)["results"]
        return result

    def meta(self, artifact_id):
        return self.table.items[(f"ARTIFACT#{artifact_id}", "METADATA")]

    def complete(self, user, artifact_id, data=PNG):
        meta = self.meta(artifact_id)
        self.stored_bytes[meta["s3Key"]] = data
        body = {"items": [{"artifactId": artifact_id, "attemptId": meta["attemptId"]}]}
        resp = self.lam("artifacts-complete").handler(event(user, body=body), None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return response_body(resp)["results"][0]

    def ready_image(self, user, device_ids, data=PNG, **spec):
        result = self.presign_one(user, self.image(**spec), device_ids)
        self.assertTrue(result["ok"], result)
        done = self.complete(user, result["artifactId"], data)
        self.assertEqual((done["ok"], done["status"]), (True, "ready"), done)
        return result["artifactId"]

    def view(self, user, ids):
        body = ids if isinstance(ids, str) else {"artifactIds": ids}
        return self.lam("artifacts-get").handler(event(user, "/artifacts/view-urls", body=body), None)

    def view_results(self, user, ids):
        resp = self.view(user, ids)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        return response_body(resp)["results"]

    def patch(self, user, artifact_id, body):
        return self.lam("artifacts-update").handler(
            event(user, "/artifacts/{artifactId}", body=body, path={"artifactId": artifact_id}), None)


# --- Upload (presign) ---------------------------------------------------------------


class ImagePresignTests(ImageTestCase):
    def test_personal_image_upload(self):
        result = self.presign_one(USER, self.image(description="Main board, top side",
                                                   capturedAt="2026-09-01T10:30:00+10:00"), [DP])
        self.assertTrue(result["ok"], result)
        aid = result["artifactId"]
        meta = self.meta(aid)
        self.assertEqual(meta["type"], "image")
        self.assertEqual(meta["mimeType"], "image/png")
        self.assertEqual(meta["title"], "board.png")  # defaults to the name
        self.assertEqual(meta["description"], "Main board, top side")
        self.assertEqual(meta["capturedAt"], "2026-09-01T00:30:00+00:00")  # normalized to UTC
        self.assertEqual(meta["status"], "pending")
        self.assertEqual(meta["uploadMode"], "single")
        self.assertNotIn("workspaceId", meta)
        self.assertNotIn("reverseEngineeringStatus", meta)
        self.assertIn("createdAt", meta)
        self.assertIn("updatedAt", meta)
        # The ordinary artifact rows: ownership, batch and device links.
        self.assertIn((f"USER#{USER}", f"ARTIFACT#{aid}"), self.table.items)
        self.assertIn((f"DEVICE#{DP}", f"ARTIFACT#image#{aid}"), self.table.items)
        self.assertIn((f"ARTIFACT#{aid}", f"DEVICE#{DP}"), self.table.items)
        # No separate image entity or storage.
        self.assertFalse([k for k in self.table.items if k[0].startswith("IMAGE#") or k[1].startswith("IMAGE#")])
        self.assertTrue(meta["s3Key"].startswith(f"artifacts/{aid}/"))

    def test_presigned_post_pins_image_content_type(self):
        self.presign_one(USER, self.image(name="pcb.jpg", mime="image/jpeg"), [DP])
        kwargs = self.lam("artifacts-presign").s3.generate_presigned_post.call_args.kwargs
        self.assertEqual(kwargs["Fields"]["Content-Type"], "image/jpeg")
        self.assertIn({"Content-Type": "image/jpeg"}, kwargs["Conditions"])
        self.assertIn(["content-length-range", 1000, 1000], kwargs["Conditions"])
        self.assertIn({"x-amz-checksum-algorithm": "SHA256"}, kwargs["Conditions"])

    def test_other_types_still_use_octet_stream(self):
        self.presign(USER, [self.file(artifact_type="pcap")], deviceIds=[DP])
        kwargs = self.lam("artifacts-presign").s3.generate_presigned_post.call_args.kwargs
        self.assertEqual(kwargs["Fields"]["Content-Type"], "application/octet-stream")

    def test_explicit_title_and_mime_case(self):
        aid = self.presign_one(USER, self.image(mime="IMAGE/WEBP", title="  UART header  "), [DP])["artifactId"]
        self.assertEqual((self.meta(aid)["mimeType"], self.meta(aid)["title"]), ("image/webp", "UART header"))

    def test_long_name_default_title_is_cut(self):
        name = "x" * 250 + ".png"
        aid = self.presign_one(USER, self.image(name=name), [DP])["artifactId"]
        self.assertEqual(self.meta(aid)["title"], "x" * 200)

    def test_workspace_member_uploads_workspace_image(self):
        aid = self.presign_one(MEMBER, self.image(), [D1])["artifactId"]
        meta = self.meta(aid)
        self.assertEqual(meta["workspaceId"], W1)
        self.assertIn((f"WORKSPACE#{W1}", f"ARTIFACT#{aid}"), self.table.items)
        self.assertNotIn((f"USER#{MEMBER}", f"ARTIFACT#{aid}"), self.table.items)
        self.assertIn((f"DEVICE#{D1}", f"ARTIFACT#image#{aid}"), self.table.items)

    def test_unauthorized_and_cross_scope_uploads_are_refused(self):
        before = set(self.table.items)
        for user, devices, status in ((OUTSIDER, [D1], 403), (W2_OWNER, [D1], 403), (MEMBER, [DP], 403),
                                      (USER, [DP, D1], 400), (USER, [D1, D3], 403)):
            with self.subTest(user=user, devices=devices):
                resp = self.presign(user, [self.image()], deviceIds=devices)
                self.assertEqual(resp["statusCode"], status, resp["body"])
        self.assertEqual(set(self.table.items), before)

    def rejected(self, spec, message_part):
        resp = self.presign(USER, [spec], deviceIds=[DP])
        self.assertEqual(resp["statusCode"], 200)  # per-file results
        [result] = response_body(resp)["results"]
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["status"], 400)
        self.assertIn(message_part, result["error"])

    def test_unsupported_formats_are_rejected(self):
        for mime in ("image/svg+xml", "image/gif", "image/tiff", "image/heic", "text/html",
                     "application/octet-stream", "image/jpg", "", None, 42):
            with self.subTest(mime=mime):
                self.rejected(self.image(mime=mime), "mimeType must be one of")
        self.assertEqual([k for k in self.table.items if k[1] == "METADATA" and k[0].startswith("ARTIFACT#")], [])

    def test_size_limit(self):
        self.rejected(self.image(size=25 * MIB + 1), "Images can be at most 26214400 bytes")
        self.rejected(self.image(size=100 * MIB), "Images can be at most")
        aid = self.presign_one(USER, self.image(size=25 * MIB), [DP])["artifactId"]
        self.assertEqual(self.meta(aid)["uploadMode"], "single")
        self.lam("artifacts-presign").s3.create_multipart_upload.assert_not_called()

    def test_image_metadata_validation(self):
        cases = [
            ({"title": "t" * 201}, "title must be at most 200"),
            ({"title": "bad\x00title"}, "title contains invalid characters"),
            ({"title": "line\nbreak"}, "title contains invalid characters"),
            ({"title": "   "}, "title must be a non-empty string"),
            ({"title": 5}, "title must be a non-empty string"),
            ({"description": "d" * 2001}, "description must be at most 2000"),
            ({"description": "bell\x07"}, "description contains invalid characters"),
            ({"description": ["x"]}, "description must be a string"),
            ({"capturedAt": "2026-09-01T10:30:00"}, "time-zone offset"),
            ({"capturedAt": "yesterday"}, "not a valid ISO-8601"),
            ({"capturedAt": "2026-13-01"}, "not a valid ISO-8601"),
            ({"capturedAt": "2999-01-01T00:00:00Z"}, "out of range"),
            ({"capturedAt": "2999-01-01"}, "out of range"),
            ({"capturedAt": "1950-01-01"}, "out of range"),
            ({"capturedAt": 1700000000}, "capturedAt must be an ISO-8601"),
            ({"version": "1.0"}, "version is only allowed for firmware"),
        ]
        for extra, message in cases:
            with self.subTest(extra=extra):
                self.rejected(self.image(**extra), message)

    def test_valid_optional_metadata(self):
        aid = self.presign_one(USER, self.image(description="Line one\nLine two\ttabbed",
                                                capturedAt="2026-08-15"), [DP])["artifactId"]
        self.assertEqual(self.meta(aid)["description"], "Line one\nLine two\ttabbed")
        self.assertEqual(self.meta(aid)["capturedAt"], "2026-08-15")
        aid = self.presign_one(USER, self.image(name="b.png", description="  ", capturedAt=None), [DP])["artifactId"]
        self.assertNotIn("description", self.meta(aid))
        self.assertNotIn("capturedAt", self.meta(aid))
        aid = self.presign_one(USER, self.image(name="c.png", capturedAt="2026-08-15T09:00:00Z"), [DP])["artifactId"]
        self.assertEqual(self.meta(aid)["capturedAt"], "2026-08-15T09:00:00+00:00")

    def test_image_fields_refused_on_other_types(self):
        for field, value in (("mimeType", "image/png"), ("title", "x"), ("description", "x"),
                             ("capturedAt", "2026-01-01")):
            with self.subTest(field=field):
                resp = self.presign(USER, [{**self.file(artifact_type="pcap"), field: value}], deviceIds=[DP])
                [result] = response_body(resp)["results"]
                self.assertEqual((result["ok"], result["status"]), (False, 400))
                self.assertIn("only allowed for images", result["error"])

    def test_retry_keeps_image_content_type(self):
        result = self.presign_one(USER, self.image(name="pcb.webp", mime="image/webp"), [DP])
        presign = self.lam("artifacts-presign")
        presign.s3.generate_presigned_post.reset_mock()
        resp = presign.handler(event(USER, "/artifacts/{artifactId}/retry", body={"attemptId": result["attemptId"]},
                                     path={"artifactId": result["artifactId"]}), None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        kwargs = presign.s3.generate_presigned_post.call_args.kwargs
        self.assertEqual(kwargs["Fields"]["Content-Type"], "image/webp")
        self.assertIn({"Content-Type": "image/webp"}, kwargs["Conditions"])


# --- Upload verification (complete) -------------------------------------------------


class ImageCompleteTests(ImageTestCase):
    def test_valid_images_become_ready(self):
        complete = self.lam("artifacts-complete")
        for name, mime, data in (("a.png", "image/png", PNG), ("b.jpg", "image/jpeg", JPEG),
                                 ("c.webp", "image/webp", WEBP)):
            with self.subTest(mime=mime):
                aid = self.ready_image(USER, [DP], data=data, name=name, mime=mime)
                meta = self.meta(aid)
                self.assertEqual(meta["status"], "ready")
                self.assertIn("uploadedAt", meta)
                complete.s3.put_object_tagging.assert_called_with(
                    Bucket=meta["s3Bucket"], Key=meta["s3Key"],
                    Tagging={"TagSet": [{"Key": "upload-state", "Value": "committed"}]})
        self.assertEqual(set(self.ranges), {"bytes=0-11"})  # only the first bytes are read

    def assert_failed(self, aid, data, message):
        complete = self.lam("artifacts-complete")
        complete.s3.put_object_tagging.reset_mock()
        result = self.complete(USER, aid, data)
        self.assertEqual((result["ok"], result["status"]), (False, 422), result)
        self.assertIn(message, result["error"])
        meta = self.meta(aid)
        self.assertEqual(meta["status"], "failed")
        self.assertIn(message, meta["statusReason"])
        complete.s3.put_object_tagging.assert_not_called()  # stays pending; lifecycle deletes it

    def test_svg_and_html_disguised_as_images_fail(self):
        for data in (SVG, HTML, b"MZ\x90\x00executable!!", b""):
            with self.subTest(data=data[:8]):
                aid = self.presign_one(USER, self.image(name=f"x{len(self.table.items)}.png"), [DP])["artifactId"]
                self.assert_failed(aid, data, "not a valid image/png image")

    def test_mime_signature_mismatch_fails(self):
        for mime, data in (("image/png", JPEG), ("image/jpeg", PNG), ("image/webp", PNG),
                           ("image/jpeg", b"RIFF\x00\x00\x00\x00WAVEfmt ")):
            with self.subTest(mime=mime):
                aid = self.presign_one(USER, self.image(name=f"m{len(self.table.items)}", mime=mime),
                                       [DP])["artifactId"]
                self.assert_failed(aid, data, f"not a valid {mime} image")

    def test_stored_content_type_must_match(self):
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        self.content_types[self.meta(aid)["s3Key"]] = "application/octet-stream"
        self.assert_failed(aid, PNG, "not stored as image/png")

    def test_tampered_record_with_unsupported_mime_fails(self):
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        self.meta(aid)["mimeType"] = "image/svg+xml"
        self.content_types[self.meta(aid)["s3Key"]] = "image/svg+xml"
        self.assert_failed(aid, SVG, "Unsupported image type")

    def test_multipart_image_record_is_refused(self):
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        self.meta(aid)["uploadMode"] = "multipart"
        self.assert_failed(aid, PNG, "single request")

    def test_checksum_mismatch_still_fails_first(self):
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        complete = self.lam("artifacts-complete")
        complete.s3.head_object.side_effect = lambda **kw: {"ContentLength": 1, "ChecksumSHA256": "x"}
        result = self.complete(USER, aid, PNG)
        self.assertEqual((result["ok"], result["status"]), (False, 422))
        self.assertIn("declared size and SHA-256", result["error"])

    def test_workspace_member_completes_and_outsider_cannot(self):
        aid = self.presign_one(USER, self.image(), [D1])["artifactId"]
        for user in (OUTSIDER, W2_OWNER):
            result = self.complete(user, aid, PNG)
            self.assertEqual((result["ok"], result["status"]), (False, 404))
        self.assertEqual(self.meta(aid)["status"], "pending")
        result = self.complete(MEMBER, aid, PNG)
        self.assertEqual((result["ok"], result["status"]), (True, "ready"))

    def test_non_image_completion_is_unchanged(self):
        result = response_body(self.presign(USER, [self.file(artifact_type="pcap")], deviceIds=[DP]))["results"][0]
        done = self.complete(USER, result["artifactId"], b"\xd4\xc3\xb2\xa1")
        self.assertEqual((done["ok"], done["status"]), (True, "ready"))
        self.lam("artifacts-complete").s3.get_object.assert_not_called()

    def test_unreadable_object_is_retryable_and_never_failed(self):
        complete = self.lam("artifacts-complete")
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        for error in (ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject"),
                      ClientError({"Error": {"Code": "403"}}, "GetObject"),
                      ClientError({"Error": {"Code": "SlowDown"}}, "GetObject"),
                      ClientError({"Error": {"Code": "InternalError"}}, "GetObject"),
                      ReadTimeoutError(endpoint_url="https://s3.example")):
            with self.subTest(error=type(error).__name__ + str(getattr(error, "response", ""))):
                complete.s3.get_object.side_effect = error
                result = self.complete(USER, aid, PNG)
                self.assertEqual((result["ok"], result["status"]), (False, 409))
                self.assertIn("retry", result["error"])
                self.assertEqual(self.meta(aid)["status"], "pending")
                self.assertNotIn("statusReason", self.meta(aid))
        complete.s3.put_object_tagging.assert_not_called()
        # Once S3 can be read again, the same attempt completes normally.
        complete.s3.get_object.side_effect = self._get_object
        result = self.complete(USER, aid, PNG)
        self.assertEqual((result["ok"], result["status"]), (True, "ready"))

    def test_streaming_failure_while_reading_is_retryable(self):
        complete = self.lam("artifacts-complete")
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        body = mock.Mock()
        body.read.side_effect = ReadTimeoutError(endpoint_url="https://s3.example")
        complete.s3.get_object.side_effect = lambda **kw: {"Body": body}
        result = self.complete(USER, aid, PNG)
        self.assertEqual((result["ok"], result["status"]), (False, 409))
        body.close.assert_called_once()
        self.assertEqual(self.meta(aid)["status"], "pending")

    def test_read_failure_affects_only_its_own_item(self):
        complete = self.lam("artifacts-complete")
        first = self.presign_one(USER, self.image(name="a.png"), [DP])["artifactId"]
        second = self.presign_one(USER, self.image(name="b.png"), [DP])["artifactId"]
        broken = self.meta(first)["s3Key"]
        for aid in (first, second):
            self.stored_bytes[self.meta(aid)["s3Key"]] = PNG

        def get_object(Bucket, Key, Range=None):
            if Key == broken:
                raise ClientError({"Error": {"Code": "ServiceUnavailable"}}, "GetObject")
            return self._get_object(Bucket, Key, Range)

        complete.s3.get_object.side_effect = get_object
        body = {"items": [{"artifactId": a, "attemptId": self.meta(a)["attemptId"]} for a in (first, second)]}
        resp = complete.handler(event(USER, body=body), None)
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        one, two = response_body(resp)["results"]
        self.assertEqual((one["artifactId"], one["ok"], one["status"]), (first, False, 409))
        self.assertEqual((two["artifactId"], two["ok"], two["status"]), (second, True, "ready"))
        self.assertEqual((self.meta(first)["status"], self.meta(second)["status"]), ("pending", "ready"))

    def test_unexpected_read_error_still_raises(self):
        # Same convention as HeadObject: only missing-object and transient
        # errors are mapped; anything else (a misconfiguration) surfaces.
        complete = self.lam("artifacts-complete")
        aid = self.presign_one(USER, self.image(), [DP])["artifactId"]
        complete.s3.get_object.side_effect = ClientError({"Error": {"Code": "InvalidObjectState"}}, "GetObject")
        with self.assertRaises(ClientError):
            self.complete(USER, aid, PNG)
        self.assertEqual(self.meta(aid)["status"], "pending")


# --- Metadata editing (PATCH /artifacts/{id}) ---------------------------------------


class ImageUpdateTests(ImageTestCase):
    def setUp(self):
        super().setUp()
        self.personal = self.ready_image(USER, [DP], description="Old", capturedAt="2026-01-02")
        self.workspace = self.ready_image(USER, [D1], name="ws.png")
        self.firmware = self.upload(USER, [DP])

    def test_owner_edits_all_fields(self):
        self.meta(self.personal)["updatedAt"] = "2026-01-01T00:00:00+00:00"
        before = copy.deepcopy(self.meta(self.personal))
        resp = self.patch(USER, self.personal, {"title": " PCB top ", "description": "New\ndescription",
                                                "capturedAt": "2026-09-01T08:00:00-04:00"})
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        body = response_body(resp)
        self.assertEqual(body["title"], "PCB top")
        self.assertEqual(body["description"], "New\ndescription")
        self.assertEqual(body["capturedAt"], "2026-09-01T12:00:00+00:00")
        self.assertEqual(body["mimeType"], "image/png")
        self.assertEqual((body["type"], body["status"]), ("image", "ready"))
        meta = self.meta(self.personal)
        self.assertEqual(meta["title"], "PCB top")
        self.assertGreater(meta["updatedAt"], before["updatedAt"])
        self.assertEqual(body["updatedAt"], meta["updatedAt"])
        # Upload facts and timestamps aren't touched.
        for field in ("createdAt", "uploadedAt", "sha256", "s3Key", "mimeType", "name", "status"):
            self.assertEqual(meta[field], before[field], field)

    def test_partial_update_and_removal(self):
        self.patch(USER, self.personal, {"capturedAt": "2025-12-31"})
        self.assertEqual(self.meta(self.personal)["capturedAt"], "2025-12-31")
        self.assertEqual(self.meta(self.personal)["description"], "Old")
        for removal in (None, "", "   "):
            with self.subTest(removal=removal):
                self.patch(USER, self.personal, {"description": "x", "capturedAt": "2026-01-01"})
                resp = self.patch(USER, self.personal, {"description": removal, "capturedAt": removal})
                self.assertEqual(resp["statusCode"], 200, resp["body"])
                self.assertNotIn("description", self.meta(self.personal))
                self.assertNotIn("capturedAt", self.meta(self.personal))
                body = response_body(resp)
                self.assertIsNone(body["description"])
                self.assertIsNone(body["capturedAt"])

    def test_invalid_values_change_nothing(self):
        before = copy.deepcopy(self.meta(self.personal))
        cases = [
            {"title": None}, {"title": ""}, {"title": "t" * 201}, {"title": "a\x1bb"},
            {"description": "d" * 2001}, {"description": 3},
            {"capturedAt": "2026-09-01 10:00"}, {"capturedAt": "2999-01-01"}, {"capturedAt": True},
            {"title": "ok", "capturedAt": "bad"},
        ]
        for body in cases:
            with self.subTest(body=body):
                resp = self.patch(USER, self.personal, body)
                self.assertEqual(resp["statusCode"], 400, resp["body"])
        self.assertEqual(self.meta(self.personal), before)

    def test_bad_requests(self):
        self.assertEqual(self.patch(USER, self.personal, {})["statusCode"], 400)
        resp = self.patch(USER, self.personal, {"mimeType": "image/jpeg"})
        self.assertEqual(response_body(resp), {"error": "Unsupported field(s): mimeType"})
        for field in ("status", "name", "s3Key", "workspaceId", "createdAt", "updatedAt", "type"):
            with self.subTest(field=field):
                self.assertEqual(self.patch(USER, self.personal, {field: "x"})["statusCode"], 400)
        for body in ({"reverseEngineeringStatus": "complete"},
                     {"reverseEngineeringStatus": "complete", "title": "x"}):
            with self.subTest(body=body):
                resp = self.patch(USER, self.personal, body)
                self.assertEqual(response_body(resp),
                                 {"error": "reverseEngineeringStatus is only supported for firmware artifacts"})
        self.assertNotIn("reverseEngineeringStatus", self.meta(self.personal))
        self.assertNotEqual(self.meta(self.personal)["title"], "x")

    def test_image_fields_refused_on_firmware_and_firmware_status_still_works(self):
        resp = self.patch(USER, self.firmware, {"title": "x"})
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("only supported for image artifacts", response_body(resp)["error"])
        self.assertNotIn("title", self.meta(self.firmware))
        resp = self.patch(USER, self.firmware, {"reverseEngineeringStatus": "complete"})
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        self.assertEqual(response_body(resp)["reverseEngineeringStatus"], "complete")
        self.assertEqual(self.patch(USER, self.firmware, {})["statusCode"], 400)

    def test_authorization(self):
        # Personal image: only its owner.
        for user in (MEMBER, W2_OWNER, OUTSIDER):
            with self.subTest(user=user):
                resp = self.patch(user, self.personal, {"title": "hijacked"})
                self.assertEqual((resp["statusCode"], response_body(resp)), (404, {"error": "Artifact not found"}))
        # Workspace image: any member of its workspace, nobody else.
        self.assertEqual(self.patch(MEMBER, self.workspace, {"title": "by member"})["statusCode"], 200)
        for user in (W2_OWNER, OUTSIDER):
            self.assertEqual(self.patch(user, self.workspace, {"title": "nope"})["statusCode"], 404)
        add_rows(self.table, [{"pk": f"USER#{OUTSIDER}", "sk": f"ARTIFACT#{self.workspace}", "role": "owner"}])
        self.assertEqual(self.patch(OUTSIDER, self.workspace, {"title": "nope"})["statusCode"], 404)
        self.assertEqual(self.meta(self.workspace)["title"], "by member")
        self.assertEqual(self.patch(USER, MISSING, {"title": "x"})["statusCode"], 404)


# --- Inline view URLs (POST /artifacts/view-urls) -----------------------------------


class ImageViewUrlTests(ImageTestCase):
    def setUp(self):
        super().setUp()
        self.personal = self.ready_image(USER, [DP], name="pcb.jpg", mime="image/jpeg", data=JPEG)
        self.ws1 = self.ready_image(MEMBER, [D1], name="ws1.png")
        self.ws2 = self.ready_image(W2_OWNER, [D3], name="ws2.webp", mime="image/webp", data=WEBP)
        self.firmware = self.upload(USER, [DP])
        self.pending = self.presign_one(USER, self.image(name="pending.png"), [DP])["artifactId"]
        self.get = self.lam("artifacts-get")
        self.get.s3.generate_presigned_url.reset_mock()

    def test_owner_gets_inline_url(self):
        [result] = self.view_results(USER, [self.personal])
        self.assertEqual(result, {"artifactId": self.personal, "ok": True, "url": "https://download",
                                  "mimeType": "image/jpeg", "expiresIn": 300})
        args, kwargs = self.get.s3.generate_presigned_url.call_args
        self.assertEqual(args, ("get_object",))
        meta = self.meta(self.personal)
        params = kwargs["Params"]
        self.assertEqual((params["Bucket"], params["Key"]), (meta["s3Bucket"], meta["s3Key"]))
        self.assertEqual(params["ResponseContentType"], "image/jpeg")
        self.assertTrue(params["ResponseContentDisposition"].startswith('inline; filename="pcb.jpg"'))
        self.assertEqual(params["ResponseCacheControl"], "private, max-age=300")
        self.assertEqual(kwargs["ExpiresIn"], 300)

    def test_workspace_member_access_and_isolation(self):
        results = self.view_results(USER, [self.ws1, self.ws2, self.personal])
        self.assertEqual([(r["artifactId"], r["ok"]) for r in results],
                         [(self.ws1, True), (self.ws2, False), (self.personal, True)])
        results = self.view_results(MEMBER, [self.ws1, self.ws2, self.personal])
        self.assertEqual([r["ok"] for r in results], [True, False, False])
        results = self.view_results(W2_OWNER, [self.ws1, self.ws2, self.personal])
        self.assertEqual([r["ok"] for r in results], [False, True, False])
        results = self.view_results(OUTSIDER, [self.ws1, self.ws2, self.personal])
        self.assertEqual([r["ok"] for r in results], [False, False, False])

    def test_unavailable_ids_are_indistinguishable(self):
        ids = [self.ws2, self.firmware, self.pending, MISSING]
        results = self.view_results(USER, ids)
        self.assertEqual(results, [{"artifactId": i, "ok": False, "status": 404, "error": "Image not found"}
                                   for i in ids])
        self.get.s3.generate_presigned_url.assert_not_called()

    def test_non_image_artifacts_are_refused(self):
        for artifact_type in ("pcap", "log", "binary", "report", "other"):
            with self.subTest(artifact_type=artifact_type):
                aid = self.upload(USER, [DP], artifact_type=artifact_type)
                [result] = self.view_results(USER, [aid])
                self.assertEqual((result["ok"], result["status"]), (False, 404))
                # Even with an image mimeType on the record, the type decides.
                self.meta(aid)["mimeType"] = "image/png"
                [result] = self.view_results(USER, [aid])
                self.assertEqual((result["ok"], result["status"]), (False, 404))
        self.get.s3.generate_presigned_url.assert_not_called()

    def test_tampered_mime_type_is_refused(self):
        self.meta(self.personal)["mimeType"] = "image/svg+xml"
        [result] = self.view_results(USER, [self.personal])
        self.assertFalse(result["ok"])
        self.get.s3.generate_presigned_url.assert_not_called()

    def test_stale_owner_link_does_not_bypass_membership(self):
        add_rows(self.table, [
            {"pk": f"USER#{OUTSIDER}", "sk": f"ARTIFACT#{self.ws1}", "entity": "user-artifact", "role": "owner"},
        ])
        [result] = self.view_results(OUTSIDER, [self.ws1])
        self.assertFalse(result["ok"])

    def test_invalid_ids_duplicates_and_order(self):
        results = self.view_results(USER, [self.personal, "not-a-uuid", self.personal, 7, self.ws1])
        self.assertEqual([(r["artifactId"], r["ok"], r.get("status")) for r in results], [
            (self.personal, True, None), ("not-a-uuid", False, 400), (None, False, 400), (self.ws1, True, None),
        ])

    def test_bad_requests(self):
        for body in ("{bad json", "[]", {}, {"artifactIds": []}, {"artifactIds": "x"},
                     {"artifactIds": [MISSING] * 101}):
            with self.subTest(body=str(body)[:30]):
                resp = self.get.handler(event(USER, "/artifacts/view-urls", body=body), None)
                self.assertEqual(resp["statusCode"], 400, resp["body"])
        self.assertEqual(len(self.view_results(USER, [MISSING] * 100)), 1)  # 100 allowed, deduplicated

    def test_download_of_image_stays_an_attachment(self):
        resp = self.get.handler(event(USER, "/artifacts/{artifactId}/download",
                                      path={"artifactId": self.personal}), None)
        self.assertEqual(resp["statusCode"], 200)
        params = self.get.s3.generate_presigned_url.call_args.kwargs["Params"]
        self.assertTrue(params["ResponseContentDisposition"].startswith("attachment;"))
        self.assertNotIn("ResponseContentType", params)


# --- Reads and device listings ------------------------------------------------------


class ImageListingTests(ImageTestCase):
    def setUp(self):
        super().setUp()
        self.fw = self.upload(USER, [D1])
        self.img1 = self.ready_image(USER, [D1], name="one.png", capturedAt="2026-07-01")
        self.img2 = self.ready_image(MEMBER, [D1], name="two.png")
        self.img3 = self.ready_image(MEMBER, [D1], name="three.png")
        self.other_device = self.ready_image(MEMBER, [D2], name="d2.png")
        self.w2 = self.ready_image(W2_OWNER, [D3], name="w2.png")
        self.personal = self.ready_image(USER, [DP], name="mine.png")

    def device_list(self, user, device, query=None):
        return self.lam("artifacts-list").handler(
            event(user, "/devices/{deviceId}/artifacts", path={"deviceId": device}, query=query), None)

    def test_device_gallery_query(self):
        resp = self.device_list(MEMBER, D1, {"type": "image"})
        self.assertEqual(resp["statusCode"], 200, resp["body"])
        artifacts = response_body(resp)["artifacts"]
        self.assertEqual({a["artifactId"] for a in artifacts}, {self.img1, self.img2, self.img3})
        self.assertIn((f"DEVICE#{D1}", "ARTIFACT#image#"), self.table.queries)
        one = next(a for a in artifacts if a["artifactId"] == self.img1)
        self.assertEqual(one["type"], "image")
        self.assertEqual(one["title"], "one.png")
        self.assertEqual(one["mimeType"], "image/png")
        self.assertEqual(one["capturedAt"], "2026-07-01")
        self.assertIsNone(one["description"])
        self.assertEqual(one["workspaceId"], W1)
        for key in ("createdAt", "uploadedAt", "updatedAt", "status", "sha256", "sizeBytes"):
            self.assertIn(key, one)
        self.assertNotIn("s3Key", one)
        self.assertNotIn("url", one)  # listings never carry object URLs

    def test_device_gallery_pagination(self):
        first = response_body(self.device_list(USER, D1, {"type": "image", "limit": "2"}))
        self.assertEqual(len(first["artifacts"]), 2)
        self.assertIn("nextToken", first)
        second = response_body(self.device_list(USER, D1, {"type": "image", "limit": "2",
                                                           "nextToken": first["nextToken"]}))
        self.assertNotIn("nextToken", second)
        ids = [a["artifactId"] for a in first["artifacts"] + second["artifacts"]]
        self.assertEqual(ids, [self.img3, self.img2, self.img1])  # newest first (UUIDv7)

    def test_device_gallery_authorization(self):
        for user in (OUTSIDER, W2_OWNER):
            self.assertEqual(self.device_list(user, D1, {"type": "image"})["statusCode"], 403)
        self.assertEqual(self.device_list(MEMBER, DP, {"type": "image"})["statusCode"], 403)
        ids = {a["artifactId"] for a in response_body(self.device_list(USER, DP, {"type": "image"}))["artifacts"]}
        self.assertEqual(ids, {self.personal})

    def test_forged_device_link_exposes_nothing(self):
        add_rows(self.table, [{"pk": f"DEVICE#{D1}", "sk": f"ARTIFACT#image#{self.w2}", "type": "image"},
                              {"pk": f"DEVICE#{D1}", "sk": f"ARTIFACT#image#{self.personal}", "type": "image"}])
        ids = {a["artifactId"] for a in response_body(self.device_list(MEMBER, D1, {"type": "image"}))["artifacts"]}
        self.assertEqual(ids, {self.img1, self.img2, self.img3})

    def test_other_type_listings_are_unchanged(self):
        artifacts = response_body(self.device_list(USER, D1, {"type": "firmware"}))["artifacts"]
        self.assertEqual([a["artifactId"] for a in artifacts], [self.fw])
        for key in ("title", "description", "mimeType", "capturedAt", "updatedAt"):
            self.assertNotIn(key, artifacts[0])
        everything = {a["artifactId"] for a in response_body(self.device_list(USER, D1))["artifacts"]}
        self.assertEqual(everything, {self.fw, self.img1, self.img2, self.img3})

    def test_general_artifact_listings_include_images(self):
        lst = self.lam("artifacts-list")
        personal = response_body(lst.handler(event(USER, "/artifacts", query={"type": "image"}), None))["artifacts"]
        self.assertEqual([a["artifactId"] for a in personal], [self.personal])
        ws = response_body(lst.handler(event(MEMBER, "/artifacts", query={"workspaceId": W1, "type": "image"}),
                                       None))["artifacts"]
        self.assertEqual({a["artifactId"] for a in ws}, {self.img1, self.img2, self.img3, self.other_device})
        self.assertEqual(lst.handler(event(OUTSIDER, "/artifacts", query={"workspaceId": W1, "type": "image"}),
                                     None)["statusCode"], 404)

    def test_get_artifact_includes_image_fields(self):
        get = self.lam("artifacts-get")
        detail = response_body(get.handler(event(MEMBER, "/artifacts/{artifactId}",
                                                 path={"artifactId": self.img1}), None))["artifact"]
        self.assertEqual((detail["title"], detail["mimeType"], detail["capturedAt"]),
                         ("one.png", "image/png", "2026-07-01"))
        self.assertEqual(detail["devices"], [{"deviceId": D1, "name": "Pump 1"}])
        fw = response_body(get.handler(event(USER, "/artifacts/{artifactId}", path={"artifactId": self.fw}),
                                       None))["artifact"]
        self.assertNotIn("title", fw)
        self.assertNotIn("mimeType", fw)
        self.assertEqual(get.handler(event(OUTSIDER, "/artifacts/{artifactId}",
                                           path={"artifactId": self.img1}), None)["statusCode"], 404)

    def test_bad_type_filter_still_rejected(self):
        self.assertEqual(self.device_list(USER, D1, {"type": "photo"})["statusCode"], 400)


# --- Shared helpers ------------------------------------------------------------------


class ImageFieldsTests(unittest.TestCase):
    def test_signatures(self):
        self.assertTrue(image_fields.matches_signature("image/png", PNG))
        self.assertTrue(image_fields.matches_signature("image/jpeg", JPEG))
        self.assertTrue(image_fields.matches_signature("image/webp", WEBP))
        self.assertFalse(image_fields.matches_signature("image/webp", b"RIFF"))
        self.assertFalse(image_fields.matches_signature("image/svg+xml", SVG))
        self.assertFalse(image_fields.matches_signature("image/png", None))

    def test_captured_at_bounds_relative_to_now(self):
        now = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(image_fields.clean_captured_at("2026-11-01", now), "2026-11-01")  # time-zone slack
        with self.assertRaises(image_fields.FieldError):
            image_fields.clean_captured_at("2026-11-02", now)
        self.assertEqual(image_fields.clean_captured_at("2026-10-31T23:00:00+00:00", now),
                         "2026-10-31T23:00:00+00:00")

    def test_public_fields_shape(self):
        self.assertEqual(image_fields.public_fields({"name": "n.png"}), {
            "title": "n.png", "description": None, "mimeType": None, "capturedAt": None, "updatedAt": None})


if __name__ == "__main__":
    unittest.main()
