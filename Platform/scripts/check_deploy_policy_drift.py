#!/usr/bin/env python3
"""Checks that the bootstrap's deploy policy templates match the live policies.

The GitHub deploy role's permissions are defined twice: as IAM policies in an
account, and as Platform/infra/bootstrap/policies/*.json.tftpl, which new
deployments are created from. On a deployment whose policies are edited in the
console, run this after every edit; it renders each template with that
deployment's values and compares it with the live policy's default version.

  # The original deployment (console-managed policies):
  python3 check_deploy_policy_drift.py --name healthcare-iot-testbed-dev \\
      --state-bucket healthcare-iot-testbed-tf-state \\
      --policy core=github-actions-deploy-policy --policy runs=deploy-runs \\
      --policy sessions=healthcare-iot-testbed-deploy-sessions

  # A deployment made with the bootstrap (policies <name>-deploy-<template>):
  python3 check_deploy_policy_drift.py --name my-testbed-dev --state-bucket my-testbed-tf-state

Exits 1 and prints a diff when a policy differs. Copy the change into the
template (with the names replaced by ${name}, ${region}, ${state_bucket}) or
into the console policy, whichever is out of date.
"""
import argparse
import difflib
import json
import os
import sys
from pathlib import Path

import boto3

TEMPLATES = Path(__file__).resolve().parent.parent / "infra" / "bootstrap" / "policies"


def render(template: str, values: dict) -> dict:
    # The templates only use plain ${var} placeholders, so this matches
    # Terraform's templatefile() for them.
    for key, value in values.items():
        template = template.replace("${" + key + "}", value)
    if "${" in template:
        raise ValueError("unrendered placeholder in template")
    return json.loads(template)


def canonical(doc: dict) -> list:
    return json.dumps(doc, indent=2, sort_keys=True).splitlines()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", required=True, help="Resource name prefix (name in envs/dev)")
    parser.add_argument("--state-bucket", required=True)
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-2"))
    parser.add_argument("--policy", action="append", default=[], metavar="TEMPLATE=POLICY_NAME",
                        help="Live policy name for a template (core, runs, sessions); default <name>-deploy-<template>")
    parser.add_argument("--profile")
    args = parser.parse_args()

    names = {path.name.removesuffix(".json.tftpl").removeprefix("deploy-"): None for path in sorted(TEMPLATES.glob("deploy-*.json.tftpl"))}
    for pair in args.policy:
        template, _, policy = pair.partition("=")
        if template not in names or not policy:
            parser.error(f"--policy {pair}: expected one of {', '.join(names)}=<policy name>")
        names[template] = policy

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    iam = session.client("iam")
    account = session.client("sts").get_caller_identity()["Account"]
    values = {"name": args.name, "region": args.region, "state_bucket": args.state_bucket}

    drift = False
    for template, policy in names.items():
        policy = policy or f"{args.name}-deploy-{template}"
        arn = f"arn:aws:iam::{account}:policy/{policy}"
        try:
            version = iam.get_policy(PolicyArn=arn)["Policy"]["DefaultVersionId"]
        except iam.exceptions.NoSuchEntityException:
            print(f"{template}: policy {policy} not found in account {account}")
            drift = True
            continue
        live = iam.get_policy_version(PolicyArn=arn, VersionId=version)["PolicyVersion"]["Document"]
        expected = render((TEMPLATES / f"deploy-{template}.json.tftpl").read_text(), values)
        if canonical(live) == canonical(expected):
            print(f"{template}: {policy} ({version}) matches")
            continue
        drift = True
        print(f"{template}: {policy} ({version}) differs from deploy-{template}.json.tftpl")
        sys.stdout.writelines(line + "\n" for line in difflib.unified_diff(
            canonical(expected), canonical(live), f"template deploy-{template}", f"live {policy}", lineterm=""))
    sys.exit(1 if drift else 0)


if __name__ == "__main__":
    main()
