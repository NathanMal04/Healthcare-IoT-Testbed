"""Unit tests for the cognito-custom-message Lambda (branded sign-up
verification email). No AWS access needed:

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import copy
import html.parser
import importlib.util
import unittest
from pathlib import Path

LAMBDAS = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "cognito_custom_message", LAMBDAS / "cognito-custom-message" / "lambda_function.py"
)
fn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fn)


def cognito_event(trigger="CustomMessage_SignUp", code="{####}"):
    """Shape of the event Cognito sends a CustomMessage trigger."""
    return {
        "version": "1",
        "region": "us-east-2",
        "userPoolId": "us-east-2_example",
        "userName": "0000-sub",
        "callerContext": {"awsSdkVersion": "aws-sdk-unknown-unknown", "clientId": "client"},
        "triggerSource": trigger,
        "request": {
            "userAttributes": {"sub": "0000-sub", "email": "user@example.com", "email_verified": "false"},
            "codeParameter": code,
            "linkParameter": None,
            "usernameParameter": None,
        },
        "response": {"smsMessage": None, "emailMessage": None, "emailSubject": None},
    }


class _TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks = []

    def handle_data(self, data):
        self.chunks.append(data)


def visible_text(markup):
    p = _TextExtractor()
    p.feed(markup)
    return " ".join(" ".join(p.chunks).split())


class SignUpEmailTests(unittest.TestCase):
    def test_signup_and_resend_get_the_branded_email(self):
        for trigger in ("CustomMessage_SignUp", "CustomMessage_ResendCode"):
            with self.subTest(trigger=trigger):
                out = fn.handler(cognito_event(trigger), None)
                self.assertEqual(out["response"]["emailSubject"], "Verify your Vzoniq account")
                self.assertIn("{####}", out["response"]["emailMessage"])

    def test_content_requirements(self):
        body = fn.handler(cognito_event(), None)["response"]["emailMessage"]
        text = visible_text(body)
        self.assertIn("Vzoniq", text)
        self.assertIn("Healthcare IoT Vulnerability Testbed", text)
        # Expiry matches Cognito's fixed 24-hour validity for sign-up codes.
        self.assertIn("expires in 24 hours", text)
        self.assertEqual(fn.CODE_VALIDITY_HOURS, 24)
        self.assertIn("Didn’t request this?", text)
        self.assertIn("safely ignore", text)

    def test_code_placeholder_appears_once_and_prominently(self):
        body = fn.handler(cognito_event(), None)["response"]["emailMessage"]
        self.assertEqual(body.count("{####}"), 1)
        line = next(l for l in body.splitlines() if "{####}" in l)
        self.assertIn("font-size:34px", line)
        self.assertIn("monospace", line)

    def test_message_is_within_cognito_limit(self):
        body = fn.handler(cognito_event(), None)["response"]["emailMessage"]
        self.assertLess(len(body), fn.MAX_EMAIL_MESSAGE_CHARS)

    def test_no_user_data_in_the_email(self):
        body = fn.handler(cognito_event(), None)["response"]["emailMessage"]
        self.assertNotIn("user@example.com", body)
        self.assertNotIn("0000-sub", body)

    def test_template_has_no_stray_format_braces(self):
        body = fn.build_email("{####}")
        stripped = body.replace("{####}", "")
        self.assertNotIn("{", stripped)
        self.assertNotIn("}", stripped)


class UntouchedTriggerTests(unittest.TestCase):
    def test_other_sources_keep_cognito_defaults(self):
        # Password reset codes expire after 1 hour, so they must not get this email.
        for trigger in (
            "CustomMessage_ForgotPassword",
            "CustomMessage_UpdateUserAttribute",
            "CustomMessage_VerifyUserAttribute",
            "CustomMessage_AdminCreateUser",
            "CustomMessage_Authentication",
        ):
            with self.subTest(trigger=trigger):
                event = cognito_event(trigger)
                before = copy.deepcopy(event)
                self.assertEqual(fn.handler(event, None), before)


class FailSafeTests(unittest.TestCase):
    def test_missing_code_parameter_falls_back_to_default(self):
        event = cognito_event(code=None)
        self.assertIsNone(fn.handler(event, None)["response"]["emailMessage"])

    def test_missing_or_null_response_is_created(self):
        event = cognito_event()
        event["response"] = None
        self.assertEqual(fn.handler(event, None)["response"]["emailSubject"], "Verify your Vzoniq account")
        event = cognito_event()
        del event["response"]
        self.assertIn("emailMessage", fn.handler(event, None)["response"])

    def test_unexpected_errors_never_raise(self):
        event = cognito_event()
        event["request"] = "not a dict"
        self.assertIs(fn.handler(event, None), event)

    def test_oversized_message_falls_back(self):
        original = fn.MAX_EMAIL_MESSAGE_CHARS
        try:
            fn.MAX_EMAIL_MESSAGE_CHARS = 10
            self.assertIsNone(fn.handler(cognito_event(), None)["response"]["emailMessage"])
        finally:
            fn.MAX_EMAIL_MESSAGE_CHARS = original


if __name__ == "__main__":
    unittest.main()
