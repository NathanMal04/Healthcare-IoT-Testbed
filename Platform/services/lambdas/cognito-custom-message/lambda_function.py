"""Cognito CustomMessage trigger: branded Vzoniq sign-up verification email.

Handles only the sign-up confirmation code emails:
  - CustomMessage_SignUp      (SignUp)
  - CustomMessage_ResendCode  (ResendConfirmationCode)

Every other trigger source (ForgotPassword, UpdateUserAttribute,
VerifyUserAttribute, AdminCreateUser, Authentication) is returned untouched,
so Cognito sends its default message exactly as before. That matters because
Cognito uses one verification template for both sign-up codes (valid 24 hours)
and password-reset codes (valid 1 hour): customizing only these two sources
keeps the stated expiry accurate.

The function never fails the sign-up: on any unexpected input or error it
returns the event unchanged and Cognito falls back to its default email.
"""

import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

HANDLED_TRIGGERS = frozenset({"CustomMessage_SignUp", "CustomMessage_ResendCode"})

# Fixed by Cognito for sign-up confirmation codes; not configurable.
# Keep in sync with SIGNUP_CODE_VALIDITY_HOURS in services/web/lib/verification.ts.
CODE_VALIDITY_HOURS = 24

EMAIL_SUBJECT = "Verify your Vzoniq account"

# Cognito's hard limit for a custom email message.
MAX_EMAIL_MESSAGE_CHARS = 20_000

_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify your Vzoniq account</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<div style="display:none;max-height:0;overflow:hidden;">Your Vzoniq verification code is inside. It expires in {hours} hours.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
<tr><td style="padding:28px 32px 8px 32px;">
<p style="margin:0;font-size:20px;font-weight:bold;letter-spacing:-0.2px;color:#0f172a;">Vzoniq</p>
<p style="margin:4px 0 0 0;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:#64748b;">Healthcare IoT Vulnerability Testbed</p>
</td></tr>
<tr><td style="padding:16px 32px 0 32px;">
<h1 style="margin:0;font-size:22px;line-height:1.3;color:#0f172a;">Verify your email address</h1>
<p style="margin:12px 0 0 0;font-size:15px;line-height:1.6;color:#334155;">Thanks for creating a Vzoniq account. Enter this code on the verification page to finish setting up your account:</p>
</td></tr>
<tr><td align="center" style="padding:24px 32px;">
<div style="display:inline-block;padding:16px 28px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;letter-spacing:8px;color:#0f172a;">{code}</div>
</td></tr>
<tr><td style="padding:0 32px;">
<p style="margin:0;font-size:14px;line-height:1.6;color:#334155;"><strong>This code expires in {hours} hours.</strong> If it expires, or you requested more than one code, use &ldquo;Resend verification code&rdquo; on the verification page &mdash; only the most recent code works.</p>
<p style="margin:16px 0 0 0;font-size:14px;line-height:1.6;color:#334155;">Never share this code. Vzoniq staff will never ask you for it.</p>
</td></tr>
<tr><td style="padding:24px 32px 28px 32px;">
<div style="border-top:1px solid #e2e8f0;padding-top:16px;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;"><strong style="color:#334155;">Didn&rsquo;t request this?</strong> Someone may have entered your email address by mistake. You can safely ignore this email &mdash; the account won&rsquo;t be activated without this code, and no further action is needed.</p>
</div>
</td></tr>
</table>
<p style="margin:16px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;">Vzoniq &middot; Healthcare IoT Vulnerability Testbed &middot; This is an automated message; replies aren&rsquo;t monitored.</p>
</td></tr>
</table>
</body>
</html>"""


def build_email(code_parameter: str) -> str:
    """Return the HTML body. `code_parameter` is Cognito's placeholder ("{####}")."""
    # str.format on the template only touches {code}/{hours}; Cognito replaces
    # the placeholder with the real code after we return.
    return _TEMPLATE.format(code=code_parameter, hours=CODE_VALIDITY_HOURS)


def handler(event, context):
    try:
        trigger = event.get("triggerSource")
        if trigger not in HANDLED_TRIGGERS:
            return event

        code_parameter = (event.get("request") or {}).get("codeParameter")
        if not code_parameter:
            logger.warning("No codeParameter for %s; using Cognito's default message", trigger)
            return event

        message = build_email(code_parameter)
        if len(message) > MAX_EMAIL_MESSAGE_CHARS:
            logger.error("Custom email is %d chars (limit %d); using default", len(message), MAX_EMAIL_MESSAGE_CHARS)
            return event

        response = event.get("response") or {}
        event["response"] = response
        response["emailSubject"] = EMAIL_SUBJECT
        response["emailMessage"] = message
        return event
    except Exception:  # never block a sign-up because of the email template
        logger.exception("CustomMessage trigger failed; using Cognito's default message")
        return event
