#parse_firmware.py
#parses firmware files over ssh or http

import argparse
import paramiko
import requests
from pathlib import Path
from urllib.parse import urlparse  #FIX: needed for safe URL filename extraction

def pull_via_ssh(host, username, password, local_dir, remote_cmd=None, download_path=None):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, username=username, password=password, timeout=15)

    #FIX: Wrap all operations in try/finally so the SSH connection is always
    #closed even if an exception is raised mid-operation.
    try:
        if remote_cmd:
            #FIX: Removed get_pty=True. PTY mode merges stderr into stdout,
            #making the separate stderr.read() call always return empty and
            #potentially causing the stdout channel to stall. Without PTY,
            #stdout and stderr are properly separated channels.
            _, stdout, stderr = client.exec_command(remote_cmd)
            print(stdout.read().decode())
            err = stderr.read().decode()
            if err:
                print('stderr:', err)

        if download_path:
            sftp = client.open_sftp()
            local_file = Path(local_dir) / Path(download_path).name
            sftp.get(download_path, str(local_file))
            sftp.close()
            print(f'Downloaded {download_path} -> {local_file}')
    finally:
        client.close()

def pull_via_http(url, local_dir):
    r = requests.get(url, stream=True, timeout=60)
    r.raise_for_status()

    #FIX: Use urlparse to extract just the path component before splitting on
    #'/'. The previous url.split('/')[-1] would include query string parameters
    #(e.g. "firmware.bin?token=xyz") as part of the filename, producing an
    #invalid or unintended file path.
    parsed_path = urlparse(url).path
    filename = parsed_path.split('/')[-1] or 'firmware.bin'
    local_path = Path(local_dir) / filename

    with open(local_path, 'wb') as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)
    print(f'Downloaded to {local_path}')

def main():
    p = argparse.ArgumentParser(description='Pull firmware from device')
    p.add_argument('--method', choices=['ssh', 'http'], default='ssh')
    p.add_argument('--host', help='Device IP')
    p.add_argument('--user', help='SSH user')
    p.add_argument('--pass', dest='password', help='SSH password')
    p.add_argument('--out', default='./firmware_dumps', help='Local output dir')
    p.add_argument('--url', help='HTTP firmware URL')
    p.add_argument('--cmd', help='SSH command e.g. "dd if=/dev/mtd0 of=/tmp/fw.bin bs=64k"')
    p.add_argument('--get', help='Remote file to SCP e.g. /tmp/fw.bin')
    args = p.parse_args()

    #FIX: Validate that required arguments are present for the chosen method
    #before proceeding, so failures produce a clear error instead of an
    #unhelpful AttributeError or TypeError deep in the call.
    if args.method == 'ssh':
        missing = [name for name, val in [('--host', args.host), ('--user', args.user), ('--pass', args.password)] if not val]
        if missing:
            p.error(f'SSH method requires: {", ".join(missing)}')
    else:
        if not args.url:
            p.error('HTTP method requires --url')

    Path(args.out).mkdir(exist_ok=True)

    if args.method == 'ssh':
        pull_via_ssh(args.host, args.user, args.password, args.out, args.cmd, args.get)
    else:
        pull_via_http(args.url, args.out)

if __name__ == "__main__":
    main()
