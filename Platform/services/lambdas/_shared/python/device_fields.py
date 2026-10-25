"""The user-supplied fields of a device's DEVICE#/METADATA record.

Deployed in the shared Lambda layer next to testbed_authz, so create-device,
update-device and list-devices validate and return the same fields.

`name` and `type` are required. The descriptive fields are optional: a value
that is missing, null, empty or only whitespace means "not provided", and is
never stored, so a device without them (including every device created before
they existed) simply has no such attribute.
"""

import unicodedata

# Maximum length of each field, in characters, after trimming.
REQUIRED_FIELDS = {"name": 255, "type": 100}
# In display order.
OPTIONAL_FIELDS = {
    "manufacturer": 100,
    "modelNumber": 100,
    "chipset": 100,
    "serialNumber": 100,
    "hardwareRevision": 50,
    "firmwareVersion": 100,
    "description": 2000,
}
# Fields that may contain line breaks and tabs; every other control
# character is still rejected.
MULTILINE_FIELDS = {"description"}
MULTILINE_ALLOWED = {"\n", "\r", "\t"}


class FieldError(ValueError):
    """A field's value is invalid; the message is safe to return to the client."""


def clean_required(field, raw):
    """Returns the trimmed value of a required field."""
    if not isinstance(raw, str) or not raw.strip():
        raise FieldError(f"{field} is required")
    return _check(field, raw.strip(), REQUIRED_FIELDS[field])


def clean_optional(field, raw):
    """Returns the trimmed value of an optional field, or None if it is absent."""
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise FieldError(f"{field} must be a string")
    value = raw.strip()
    if not value:
        return None
    return _check(field, value, OPTIONAL_FIELDS[field])


def clean_new_device(body):
    """The fields of a new device from a POST /devices body: the required ones,
    then the optional ones that were provided. Other keys are ignored."""
    values = {field: clean_required(field, body.get(field)) for field in REQUIRED_FIELDS}
    for field in OPTIONAL_FIELDS:
        value = clean_optional(field, body.get(field))
        if value is not None:
            values[field] = value
    return values


def optional_values(item):
    """The optional fields an item has, for API responses."""
    return {field: item[field] for field in OPTIONAL_FIELDS if isinstance(item.get(field), str) and item[field]}


def _check(field, value, max_length):
    if len(value) > max_length:
        raise FieldError(f"{field} must be at most {max_length} characters")
    allowed = MULTILINE_ALLOWED if field in MULTILINE_FIELDS else set()
    if any(unicodedata.category(ch) == "Cc" and ch not in allowed for ch in value):
        raise FieldError(f"{field} contains invalid characters")
    return value
