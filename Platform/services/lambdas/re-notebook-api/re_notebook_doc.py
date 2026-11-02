"""Validation of RE Notebook entry documents.

An entry's content is a structured document, never HTML: the JSON form of the
web app's editor (Tiptap/ProseMirror), restricted to what the editor offers.
The web app normalizes the editor's output before saving (lib/reNotebookDoc.ts:
links keep only href, null attributes are left out), and this module accepts
exactly that canonical form. Anything else, including a node, mark or
attribute the editor doesn't produce, is refused, so a stored document can
only ever render as the formatting below.

Schema (the editor's, with the same content rules):

  doc          block+
  paragraph    inline*                    heading      inline*, attrs {level: 1-3}
  blockquote   block+                     codeBlock    text* (no marks), attrs {language?}
  bulletList   listItem+                  orderedList  listItem+, attrs {start?}
  listItem     paragraph block*
  inline       text | hardBreak
  marks        bold, italic, code (alone: it excludes every other mark), link {href}

Links are http(s) or mailto only, so a stored link can never become a
javascript: or data: URL. The same rules, and a shared set of test documents
(tests/fixtures/re_notebook_docs.json), are used by the web app.

Future node types (gallery images, artifact and CVE references) will be
added here as new entries of NODES, referencing records by id only.
"""
import json
import re
from urllib.parse import urlsplit

SCHEMA_VERSION = 1

MAX_BYTES = 300 * 1024
MAX_DEPTH = 40
MAX_NODES = 60_000
MAX_HREF_LENGTH = 2048
MAX_ORDERED_LIST_START = 1_000_000
HEADING_LEVELS = (1, 2, 3)
LANGUAGE_PATTERN = re.compile(r"[A-Za-z0-9+#._-]{1,32}")
LINK_SCHEMES = ("http", "https", "mailto")
# C0 controls other than tab, newline and carriage return, and DEL.
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

BLOCK = frozenset({"paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock"})
INLINE = frozenset({"text", "hardBreak"})
MARKS = frozenset({"bold", "italic", "code", "link"})

# type -> (allowed child types, minimum number of children). Only the inline
# children of paragraphs and headings may carry marks.
NODES = {
    "doc": (BLOCK, 1),
    "paragraph": (INLINE, 0),
    "heading": (INLINE, 0),
    "blockquote": (BLOCK, 1),
    "bulletList": (frozenset({"listItem"}), 1),
    "orderedList": (frozenset({"listItem"}), 1),
    "listItem": (BLOCK, 1),
    "codeBlock": (frozenset({"text"}), 0),
    "hardBreak": (frozenset(), 0),
    "text": (frozenset(), 0),
}
LEAVES = frozenset({"hardBreak", "text"})

EMPTY_DOC = {"type": "doc", "content": [{"type": "paragraph"}]}


class DocumentError(ValueError):
    pass


def serialize(doc):
    """The compact JSON stored in DynamoDB (and measured against MAX_BYTES)."""
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def validate(doc):
    """Checks a document; returns (serialized JSON, text length). Raises
    DocumentError with a message safe to show to the user."""
    state = {"nodes": 0, "text": 0}
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        raise DocumentError("content must be a document")
    _node(doc, state, depth=1, marks_allowed=False)
    try:
        encoded = serialize(doc).encode("utf-8")
    except UnicodeEncodeError:
        raise DocumentError("content contains invalid characters")
    if len(encoded) > MAX_BYTES:
        raise DocumentError(f"content is too large (at most {MAX_BYTES // 1024} KB)")
    return encoded.decode("utf-8"), state["text"]


def _node(node, state, depth, marks_allowed):
    if not isinstance(node, dict):
        raise DocumentError("content contains an invalid node")
    kind = node.get("type")
    if kind not in NODES:
        raise DocumentError("content contains unsupported formatting")
    state["nodes"] += 1
    if state["nodes"] > MAX_NODES:
        raise DocumentError("content is too large")
    if depth > MAX_DEPTH:
        raise DocumentError("content is nested too deeply")

    allowed_keys = {"type", "attrs"}
    if kind not in LEAVES:
        allowed_keys.add("content")
    if kind in INLINE:
        allowed_keys.add("marks")
    if kind == "text":
        allowed_keys.add("text")
    if set(node) - allowed_keys:
        raise DocumentError("content contains unsupported formatting")

    _attrs(kind, node.get("attrs"))
    if "marks" in node:
        if not marks_allowed:
            raise DocumentError("content contains unsupported formatting")
        _marks(node["marks"])

    if kind == "text":
        text = node.get("text")
        if not isinstance(text, str) or not text:
            raise DocumentError("content contains an invalid text node")
        if CONTROL_CHARS.search(text):
            raise DocumentError("content contains invalid characters")
        state["text"] += len(text)
        return
    if kind == "hardBreak":
        return

    children_types, minimum = NODES[kind]
    children = node.get("content", [])
    if not isinstance(children, list) or len(children) < minimum:
        raise DocumentError("content has an invalid structure")
    for index, child in enumerate(children):
        if not isinstance(child, dict) or child.get("type") not in children_types:
            raise DocumentError("content has an invalid structure")
        if kind == "listItem" and index == 0 and child.get("type") != "paragraph":
            # The editor's list items start with a paragraph.
            raise DocumentError("content has an invalid structure")
        _node(child, state, depth + 1, marks_allowed=kind in ("paragraph", "heading"))


def _attrs(kind, attrs):
    if kind == "heading":
        if not isinstance(attrs, dict) or set(attrs) != {"level"} or not _is_int(attrs["level"]) \
                or attrs["level"] not in HEADING_LEVELS:
            raise DocumentError("content contains an invalid heading")
        return
    if attrs is None:
        return
    if kind == "orderedList":
        if not isinstance(attrs, dict) or set(attrs) - {"start"}:
            raise DocumentError("content contains an invalid list")
        start = attrs.get("start", 1)
        if not _is_int(start) or not 0 <= start <= MAX_ORDERED_LIST_START:
            raise DocumentError("content contains an invalid list")
        return
    if kind == "codeBlock":
        if not isinstance(attrs, dict) or set(attrs) - {"language"}:
            raise DocumentError("content contains an invalid code block")
        language = attrs.get("language")
        if language is not None and (not isinstance(language, str) or not LANGUAGE_PATTERN.fullmatch(language)):
            raise DocumentError("content contains an invalid code block")
        return
    raise DocumentError("content contains unsupported formatting")


def _marks(marks):
    if not isinstance(marks, list) or not marks:
        raise DocumentError("content contains invalid formatting")
    seen = set()
    for mark in marks:
        if not isinstance(mark, dict) or mark.get("type") not in MARKS or mark["type"] in seen:
            raise DocumentError("content contains unsupported formatting")
        seen.add(mark["type"])
        if mark["type"] == "link":
            if set(mark) != {"type", "attrs"} or not isinstance(mark["attrs"], dict) \
                    or set(mark["attrs"]) != {"href"} or not is_allowed_href(mark["attrs"]["href"]):
                raise DocumentError("content contains an invalid link (only http, https and mailto links)")
        elif set(mark) != {"type"}:
            raise DocumentError("content contains unsupported formatting")
    if "code" in seen and len(seen) > 1:
        # Inline code excludes every other mark in the editor.
        raise DocumentError("content contains unsupported formatting")


def is_allowed_href(href):
    if not isinstance(href, str) or not href or len(href) > MAX_HREF_LENGTH:
        return False
    if href != href.strip() or re.search(r"[\s\x00-\x1f\x7f]", href):
        return False
    try:
        parts = urlsplit(href)
    except ValueError:
        return False
    scheme = parts.scheme.lower()
    if scheme not in LINK_SCHEMES:
        return False
    if scheme == "mailto":
        return len(href) > len("mailto:")
    return bool(parts.netloc)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)
