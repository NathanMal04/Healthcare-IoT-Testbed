"""Unit tests for re-notebook-api/re_notebook_doc.py, the validation of RE
Notebook documents. The fixture documents are shared with the web app's
tests (lib/reNotebookDoc.test.ts), so both sides agree on what is valid.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import json
import sys
import unittest
from pathlib import Path

LAMBDAS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAMBDAS / "re-notebook-api"))

import re_notebook_doc as docs  # noqa: E402

FIXTURES = json.loads((Path(__file__).resolve().parent / "fixtures" / "re_notebook_docs.json").read_text())


def paragraph(text):
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def doc(*blocks):
    return {"type": "doc", "content": list(blocks)}


class SharedFixtureTests(unittest.TestCase):
    def test_valid_documents(self):
        for case in FIXTURES["valid"]:
            with self.subTest(case["name"]):
                serialized, _ = docs.validate(case["doc"])
                self.assertEqual(json.loads(serialized), case["doc"])

    def test_invalid_documents(self):
        for case in FIXTURES["invalid"]:
            with self.subTest(case["name"]):
                with self.assertRaises(docs.DocumentError):
                    docs.validate(case["doc"])


class LimitTests(unittest.TestCase):
    def test_text_length_counts_characters(self):
        _, length = docs.validate(doc(paragraph("héllo"), {"type": "codeBlock", "content": [
            {"type": "text", "text": "abc"}]}))
        self.assertEqual(length, 8)

    def test_size_limit(self):
        # Just under and just over 300 KB of stored JSON.
        overhead = len(docs.serialize(doc(paragraph("x")))) - 1
        docs.validate(doc(paragraph("x" * (docs.MAX_BYTES - overhead))))
        with self.assertRaisesRegex(docs.DocumentError, "too large"):
            docs.validate(doc(paragraph("x" * (docs.MAX_BYTES - overhead + 1))))

    def test_size_is_measured_in_utf8_bytes(self):
        overhead = len(docs.serialize(doc(paragraph("x")))) - 1
        with self.assertRaisesRegex(docs.DocumentError, "too large"):
            docs.validate(doc(paragraph("é" * ((docs.MAX_BYTES - overhead) // 2 + 1))))

    def test_depth_limit(self):
        def quotes(n):
            node = paragraph("deep")
            for _ in range(n):
                node = {"type": "blockquote", "content": [node]}
            return doc(node)

        docs.validate(quotes(docs.MAX_DEPTH - 3))  # doc + quotes + paragraph + text: n + 3 levels
        with self.assertRaisesRegex(docs.DocumentError, "nested too deeply"):
            docs.validate(quotes(docs.MAX_DEPTH - 2))

    def test_node_limit(self):
        many = doc(*[{"type": "paragraph"} for _ in range(docs.MAX_NODES)])
        with self.assertRaisesRegex(docs.DocumentError, "too large"):
            docs.validate(many)

    def test_lone_surrogate_is_refused(self):
        with self.assertRaisesRegex(docs.DocumentError, "invalid characters"):
            docs.validate(doc(paragraph("a\ud800b")))

    def test_serialization_is_stable(self):
        a = {"content": [{"type": "paragraph"}], "type": "doc"}
        self.assertEqual(docs.serialize(a), docs.serialize(docs.EMPTY_DOC))


IMG_A = "0192d000-0000-7000-8000-000000000001"
IMG_B = "0192d000-0000-7000-8000-000000000002"


def image(artifact_id, **attrs):
    return {"type": "image", "attrs": {"artifactId": artifact_id, **attrs}}


class ImageTests(unittest.TestCase):
    def test_image_limit(self):
        docs.validate(doc(*[image(IMG_A) for _ in range(docs.MAX_IMAGES)]))
        with self.assertRaisesRegex(docs.DocumentError, "too many images"):
            docs.validate(doc(*[image(IMG_A) for _ in range(docs.MAX_IMAGES + 1)]))

    def test_images_in_quotes_count_towards_the_limit(self):
        quoted = {"type": "blockquote", "content": [image(IMG_B)]}
        with self.assertRaisesRegex(docs.DocumentError, "too many images"):
            docs.validate(doc(quoted, *[image(IMG_A) for _ in range(docs.MAX_IMAGES)]))

    def test_alt_text_length(self):
        docs.validate(doc(image(IMG_A, alt="x" * docs.MAX_ALT_LENGTH)))
        with self.assertRaisesRegex(docs.DocumentError, "invalid image"):
            docs.validate(doc(image(IMG_A, alt="x" * (docs.MAX_ALT_LENGTH + 1))))

    def test_images_add_no_text(self):
        _, length = docs.validate(doc(paragraph("ab"), image(IMG_A, alt="Board")))
        self.assertEqual(length, 2)

    def test_image_ids_are_unique_and_in_document_order(self):
        document = doc(
            image(IMG_B),
            {"type": "bulletList", "content": [{"type": "listItem", "content": [paragraph("x"), image(IMG_A)]}]},
            image(IMG_B),
        )
        self.assertEqual(docs.image_ids(document), [IMG_B, IMG_A])
        self.assertEqual(docs.image_ids(doc(paragraph("none"))), [])


class LinkTests(unittest.TestCase):
    def test_allowed(self):
        for href in ("https://example.org/a?b=c#d", "http://10.0.0.1:8080/", "mailto:lab@example.org",
                     "HTTPS://EXAMPLE.ORG"):
            with self.subTest(href):
                self.assertTrue(docs.is_allowed_href(href))

    def test_refused(self):
        for href in ("", "javascript:alert(1)", "vbscript:x", "data:text/html,x", "file:///etc/passwd",
                     "ftp://example.org", "//example.org", "example.org", "https://exa mple.org",
                     "https://example.org/\n", "mailto:", "https://" + "a" * 2048, None, 5):
            with self.subTest(href):
                self.assertFalse(docs.is_allowed_href(href))


if __name__ == "__main__":
    unittest.main()
