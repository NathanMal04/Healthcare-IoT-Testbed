#parse_firmware.py
#parses firmware files over ssh or http

import argparse
import paramiko
import requests
from pathlib import Path

def pull_via_ssh(host, username, password, local_dir, remote_cmd=None, download_path=None):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, username=username, password=password, timeout=15)
    
    if remote_cmd:
        _, stdout, stderr = client.exec_command(remote_cmd, get_pty=True)
        print(stdout.read().decode())
        print(stderr.read().decode())
    
    if download_path:
        sftp = client.open_sftp()
        local_file = Path(local_dir) / Path(download_path).name
        sftp.get(download_path, str(local_file))
        sftp.close()
        print(f'Downloaded {download_path} -> {local_file}')
    
    client.close()

def pull_via_http(url, local_dir):
    r = requests.get(url, stream=True, timeout=60)
    r.raise_for_status()
    local_path = Path(local_dir) / url.split('/')[-1]
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

    Path(args.out).mkdir(exist_ok=True)

    if args.method == 'ssh':
        pull_via_ssh(args.host, args.user, args.password, args.out, args.cmd, args.get)
    else:
        pull_via_http(args.url, args.out)

if __name__ == "__main__":
    main()
