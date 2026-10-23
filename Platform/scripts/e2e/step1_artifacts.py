#!/usr/bin/env python3
"""End-to-end checks for step 1 (web uploads) against a deployed API.

Standard library only. Needs a Cognito ID token for a test user:

  API_URL=https://xxxx.execute-api.us-east-2.amazonaws.com/dev \\
  ID_TOKEN=eyJ... \\
  DEVICE_ID=<a device this user owns, optional> \\
  python3 Platform/scripts/e2e/step1_artifacts.py [--multipart-mb 200] [--batch-files 250]

One way to get a token: sign in on the site, then in the browser console run
  (await (await import("aws-amplify/auth")).fetchAuthSession()).tokens.idToken.toString()
or use `aws cognito-idp initiate-auth` with USER_PASSWORD_AUTH if the app
client allows it.

Everything it creates is tagged "e2e" and left in place (there is no delete
endpoint yet).
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

API_URL = os.environ.get("API_URL", "").rstrip("/")
ID_TOKEN = os.environ.get("ID_TOKEN", "")
DEVICE_ID = os.environ.get("DEVICE_ID")

failures = []


def check(condition, message):
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        failures.append(message)


# --- HTTP ----------------------------------------------------------------------

def api(method, path, body=None, query=None):
    url = f"{API_URL}{path}"
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": ID_TOKEN, **({"Content-Type": "application/json"} if data else {}),
    })
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw[:200].decode(errors="replace")}


def s3_request(method, url, data, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def post_form(upload, content):
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in upload["fields"].items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode() + content + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return s3_request("POST", upload["url"], b"".join(parts),
                      {"Content-Type": f"multipart/form-data; boundary={boundary}"})


# --- Upload helpers ----------------------------------------------------------------

def file_spec(content, name, type_="other", **extra):
    return {"clientRef": name, "originalFilename": name, "sizeBytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(), "type": type_, **extra}


def presign(files, **extra):
    status, body = api("POST", "/artifacts/presign", {"files": files, "tags": ["e2e"], **extra})
    if status != 200:
        raise RuntimeError(f"presign failed: {status} {body}")
    return body


def send_parts(artifact_id, attempt_id, upload, content, tamper_part=None):
    size = upload["partSize"]
    numbers = list(range(1, upload["partCount"] + 1))
    for start in range(0, len(numbers), 100):
        group = numbers[start:start + 100]
        chunks = {n: content[(n - 1) * size:n * size] for n in group}
        status, body = api("POST", f"/artifacts/{artifact_id}/parts", {
            "attemptId": attempt_id,
            "parts": [{"partNumber": n, "sha256": hashlib.sha256(chunks[n]).hexdigest()} for n in group],
        })
        if status != 200:
            raise RuntimeError(f"parts presign failed: {status} {body}")
        for part in body["parts"]:
            data = chunks[part["partNumber"]]
            if part["partNumber"] == tamper_part:
                data = b"\x00" + data[1:]
            code = s3_request("PUT", part["url"], data, part["headers"])
            if code != 200:
                return code
    return 200


def complete(artifact_id, attempt_id):
    status, body = api("POST", "/artifacts/complete", {"items": [{"artifactId": artifact_id, "attemptId": attempt_id}]})
    return body["results"][0] if status == 200 else {"ok": False, "status": status, "error": body}


def wait_settled(artifact_id, timeout=900):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, body = api("GET", f"/artifacts/{artifact_id}")
        if status == 200 and body["artifact"]["status"] in ("ready", "failed"):
            return body["artifact"]
        time.sleep(3)
    return None


def upload_and_complete(content, name, deviceIds=None, **extra):
    result = presign([file_spec(content, name, **extra)], **({"deviceIds": deviceIds} if deviceIds else {}))["results"][0]
    if not result["ok"]:
        return result
    if result["upload"]["mode"] == "single":
        post_form(result["upload"], content)
    else:
        send_parts(result["artifactId"], result["attemptId"], result["upload"], content)
    done = complete(result["artifactId"], result["attemptId"])
    return {**result, "complete": done}


# --- Checks --------------------------------------------------------------------

def check_single():
    content = os.urandom(1024 * 1024)
    r = upload_and_complete(content, "e2e-1mb.bin", type_="binary")
    check(r["upload"]["mode"] == "single" and r["complete"].get("status") == "ready", "1 MB single upload reaches ready")
    status, body = api("GET", f"/artifacts/{r['artifactId']}/download")
    downloaded = urllib.request.urlopen(body["url"]).read() if status == 200 else b""
    check(downloaded == content, "download returns the same bytes")


def check_multipart(mb):
    content = os.urandom(mb * 1024 * 1024)
    r = upload_and_complete(content, f"e2e-{mb}mb.bin", type_="binary")
    check(r["upload"]["mode"] == "multipart" and r["complete"].get("status") == "verifying",
          f"{mb} MB multipart upload completes into verifying")
    final = wait_settled(r["artifactId"])
    check(final is not None and final["status"] == "ready", f"{mb} MB multipart upload reaches ready")


def check_tampered_part():
    content = os.urandom(40 * 1024 * 1024)
    result = presign([file_spec(content, "e2e-tampered.bin")])["results"][0]
    code = send_parts(result["artifactId"], result["attemptId"], result["upload"], content, tamper_part=1)
    check(code == 400, f"tampered part rejected by S3 (got {code})")


def check_wrong_sha():
    content = os.urandom(2048)
    result = presign([dict(file_spec(content, "e2e-wrong-sha.bin"), sha256="0" * 64)])["results"][0]
    code = post_form(result["upload"], content)
    check(code == 400, f"single upload with a wrong declared SHA-256 rejected by S3 (got {code})")

    content = os.urandom(30 * 1024 * 1024)
    result = presign([dict(file_spec(content, "e2e-wrong-sha-mp.bin"), sha256="0" * 64)])["results"][0]
    send_parts(result["artifactId"], result["attemptId"], result["upload"], content)
    complete(result["artifactId"], result["attemptId"])
    final = wait_settled(result["artifactId"])
    check(final is not None and final["status"] == "failed", "multipart upload with a wrong declared SHA-256 ends failed")


def check_device_rules():
    status, _ = api("POST", "/artifacts/presign", {"files": [file_spec(b"x", "e2e-x.bin")], "deviceIds": [str(uuid.uuid4())]})
    check(status == 403, f"linking a device you don't own returns 403 (got {status})")
    if not DEVICE_ID:
        print("skip duplicate-firmware check (set DEVICE_ID)")
        return
    version = f"e2e-{uuid.uuid4().hex[:8]}"
    first = upload_and_complete(os.urandom(100), "e2e-fw.bin", type_="firmware", version=version,
                                deviceIds=None)
    check(first.get("ok") and first["complete"].get("status") == "ready", "firmware upload reaches ready")
    linked = presign([file_spec(os.urandom(100), "e2e-fw-linked.bin", "firmware", version=version)],
                     deviceIds=[DEVICE_ID])["results"][0]
    check(linked["ok"], "firmware linked to your device is accepted")
    dup = presign([file_spec(os.urandom(100), "e2e-fw-dup.bin", "firmware", version=version)],
                  deviceIds=[DEVICE_ID])["results"][0]
    check(dup.get("status") == 409, "duplicate firmware version on the same device returns 409")
    status, listing = api("GET", f"/devices/{DEVICE_ID}/artifacts", query={"type": "firmware", "limit": 100})
    ids = [a["artifactId"] for a in listing.get("artifacts", [])]
    check(status == 200 and linked["artifactId"] in ids, "device firmware listing includes the new version")


def check_batch(count):
    contents = [os.urandom(200 + i) for i in range(count)]
    corrupt_index = count // 2
    batch_id = None
    registered = []
    for start in range(0, count, 100):
        chunk = [file_spec(c, f"e2e-batch/{start + i:04d}.log", "log") for i, c in enumerate(contents[start:start + 100])]
        body = presign(chunk, **({"uploadBatchId": batch_id} if batch_id else {}))
        batch_id = body["uploadBatchId"]
        registered += body["results"]
    check(all(r["ok"] for r in registered) and len(registered) == count, f"{count} files registered in one batch")

    def send(i):
        r = registered[i]
        content = contents[i] if i != corrupt_index else b"corrupted" + contents[i][9:]
        post_form(r["upload"], content)
        return complete(r["artifactId"], r["attemptId"])

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        results = list(pool.map(send, range(count)))
    bad = [i for i, r in enumerate(results) if r.get("status") != "ready"]
    check(bad == [corrupt_index], f"only the corrupted file failed (failed: {bad})")

    r = registered[corrupt_index]
    status, retry = api("POST", f"/artifacts/{r['artifactId']}/retry", {"attemptId": r["attemptId"]})
    post_form(retry["upload"], contents[corrupt_index])
    check(complete(r["artifactId"], retry["attemptId"]).get("status") == "ready", "retrying the corrupted file succeeds")

    listed, token = [], None
    while True:
        status, page = api("GET", "/artifacts", query={"batchId": batch_id, "limit": 100, "nextToken": token})
        listed += page.get("artifacts", [])
        token = page.get("nextToken")
        if not token:
            break
    check(len(listed) == count and all(a["status"] == "ready" for a in listed),
          f"listing by uploadBatchId returns all {count} files, all ready")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--multipart-mb", type=int, default=200)
    parser.add_argument("--batch-files", type=int, default=250)
    args = parser.parse_args()
    if not API_URL or not ID_TOKEN:
        sys.exit("Set API_URL and ID_TOKEN (see the docstring)")

    check_single()
    check_multipart(args.multipart_mb)
    check_tampered_part()
    check_wrong_sha()
    check_device_rules()
    check_batch(args.batch_files)

    print()
    print("ALL PASSED" if not failures else f"{len(failures)} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
