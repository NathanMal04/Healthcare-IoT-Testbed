"""Image artifacts: the fields only `type = image` artifacts have, and the
checks on the stored bytes.

Deployed in the shared Lambda layer next to testbed_authz, so
artifacts-presign, artifacts-complete, artifacts-update, artifacts-get and
artifacts-list validate and return the same fields.

An image is an ordinary ARTIFACT# record (same upload pipeline, scope, links
and authorization) with these extra attributes on its METADATA:

- `mimeType`: one of IMAGE_MIME_TYPES, declared at presign time. S3 is told
  to store the object with it, artifacts-complete checks the file signature
  against it, and the view URLs serve the object with it. SVG and every other
  type are refused, so a stored image is never served as active content.
- `title`: display title, defaults to the artifact name. Editable.
- `description`: optional free text. Editable, removable.
- `capturedAt`: optional, when the photograph was taken, which may be long
  before the upload (`createdAt` / `uploadedAt`). Editable, removable.
"""

import unicodedata
from datetime import date, datetime, timedelta, timezone

IMAGE_TYPE = "image"

# MIME type -> file signature check. Nothing else is accepted.
IMAGE_MIME_TYPES = ("image/jpeg", "image/png", "image/webp")

# Images are uploaded in one presigned POST (single mode), so this is also
# never above artifacts-presign's SINGLE_UPLOAD_MAX_BYTES.
MAX_IMAGE_SIZE_BYTES = 25 * 1024 ** 2

MAX_TITLE_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 2000

# Enough bytes for every signature below (WebP needs the first 12).
SIGNATURE_BYTES = 12

# The fields a client may set on an image (presign) or change (PATCH).
EDITABLE_FIELDS = ("title", "description", "capturedAt")
# Every image-only request field; refused on artifacts of other types.
IMAGE_ONLY_FIELDS = ("mimeType",) + EDITABLE_FIELDS

# capturedAt sanity bounds: not before digital photography of these devices
# could plausibly exist, and not in the future beyond time-zone slack.
EARLIEST_CAPTURE = date(1970, 1, 1)
FUTURE_SLACK = timedelta(days=1)

_MULTILINE_ALLOWED = {"\n", "\r", "\t"}


class FieldError(ValueError):
    """A field's value is invalid; the message is safe to return to the client."""


def clean_mime_type(raw):
    if not isinstance(raw, str) or raw.strip().lower() not in IMAGE_MIME_TYPES:
        raise FieldError(f"mimeType must be one of: {', '.join(IMAGE_MIME_TYPES)}")
    return raw.strip().lower()


def clean_title(raw):
    """A non-empty title; it can be changed but not removed."""
    if not isinstance(raw, str) or not raw.strip():
        raise FieldError("title must be a non-empty string")
    return _check("title", raw.strip(), MAX_TITLE_LENGTH, multiline=False)


def clean_description(raw):
    """The trimmed description, or None to leave it unset (null, "" or whitespace)."""
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise FieldError("description must be a string")
    value = raw.strip()
    if not value:
        return None
    return _check("description", value, MAX_DESCRIPTION_LENGTH, multiline=True)


def clean_captured_at(raw, now=None):
    """When the photograph was taken, or None to leave it unset (null or "").

    Accepts a calendar date (`YYYY-MM-DD`, stored as given, for when only the
    day is known) or an ISO-8601 date-time with a time-zone offset or `Z`
    (stored in UTC, in the same format as the other timestamps). A date-time
    without an offset is refused, because its instant would be ambiguous.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise FieldError("capturedAt must be an ISO-8601 date or date-time string")
    value = raw.strip()
    if not value:
        return None
    if len(value) > 40:
        raise FieldError("capturedAt is not a valid ISO-8601 date or date-time")

    now = now or datetime.now(timezone.utc)
    if len(value) == 10:
        try:
            day = date.fromisoformat(value)
        except ValueError:
            raise FieldError("capturedAt is not a valid ISO-8601 date or date-time")
        if day < EARLIEST_CAPTURE or day > (now + FUTURE_SLACK).date():
            raise FieldError("capturedAt is out of range")
        return day.isoformat()

    text = value[:-1] + "+00:00" if value[-1:] in ("Z", "z") else value
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        raise FieldError("capturedAt is not a valid ISO-8601 date or date-time")
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise FieldError("capturedAt must include a time-zone offset (for example Z or +10:00)")
    moment = moment.astimezone(timezone.utc)
    if moment.date() < EARLIEST_CAPTURE or moment > now + FUTURE_SLACK:
        raise FieldError("capturedAt is out of range")
    return moment.isoformat()


def matches_signature(mime_type, head):
    """True if `head` (the first SIGNATURE_BYTES or more of the object) starts
    with the file signature of `mime_type`."""
    if not isinstance(head, (bytes, bytearray)):
        return False
    if mime_type == "image/png":
        return head[:8] == b"\x89PNG\r\n\x1a\n"
    if mime_type == "image/jpeg":
        return head[:3] == b"\xff\xd8\xff"
    if mime_type == "image/webp":
        return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return False


def public_fields(item):
    """The image fields for API responses (only call for `type = image`).

    Every key is always present (None when unset), so clients get one shape.
    """
    return {
        "title": item.get("title") or item.get("name"),
        "description": item.get("description"),
        "mimeType": item.get("mimeType"),
        "capturedAt": item.get("capturedAt"),
        "updatedAt": item.get("updatedAt"),
    }


def _check(field, value, max_length, multiline):
    if len(value) > max_length:
        raise FieldError(f"{field} must be at most {max_length} characters")
    allowed = _MULTILINE_ALLOWED if multiline else set()
    if any(unicodedata.category(ch) == "Cc" and ch not in allowed for ch in value):
        raise FieldError(f"{field} contains invalid characters")
    return value
