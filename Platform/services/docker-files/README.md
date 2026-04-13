# README.md

## Overview

This project provides a Docker Compose setup for a reverse engineering and firmware analysis environment.

The included applications are:

- **Ghidra**: For software reverse engineering (headless mode supported for CLI usage).
- **Binwalk**: For analyzing and extracting firmware images.
- **Python 3**: For scripting, with `boto3` pre-installed for AWS integration (e.g., invoking Lambda functions).
- **GDB**: GNU Debugger for debugging binaries.
- **Pwndbg**: A GDB plugin enhancing it for exploit development and reverse engineering.

The setup uses a multi-stage Dockerfile to minimize image size and is designed for deployment on AWS infrastructure such as EC2, with readiness for further integration like executing Python scripts via AWS Lambda.

### Key Features

- **Single Container**: All tools in one service to reduce overhead (no inter-service networking).
- **AWS Readiness**: `boto3` allows Python scripts to interact with AWS services. Run on EC2 with an IAM role for seamless credential-free access.
- **Persistent Workspace**: Mount your local directory to `/workspace` for files and scripts.
- **Headless/CLI Focus**: No GUI to save resources. Ghidra runs in headless mode; extend with X11 forwarding if a GUI is needed.
- **Resource Limits**: Memory and CPU limits are set in `docker-compose.yaml`. Defaults are `4g` memory and `1.0` CPU — sufficient for Ghidra analysis. Adjust as needed for your host.

### Image Size Note

The final image is approximately **3–4 GB** due to Ghidra (requires OpenJDK 17) and Pwndbg (installed with its full Python dependency set in the runtime stage). Pwndbg is intentionally installed in the runtime stage rather than the builder stage so its Python packages are available to GDB at runtime.

---

## Prerequisites

- Docker version 20+.
- Docker Compose version 1.29+ (or Docker Desktop). The `docker-compose.yaml` uses **version 2.4** syntax for correct enforcement of `mem_limit` and `cpus` outside of Swarm mode.
- For AWS: An AWS account, an EC2 instance with Docker installed, and an IAM role/policy granting Lambda invoke access if invoking functions from the container.

---

## Setup and Usage

### Local Development

1. Clone or download this repository (contains `docker-compose.yaml`, `Dockerfile`, `parse_firmware.py`, `analyze_entropy.py`, and this README).
2. Build and start the container:
   ```bash
   docker-compose up --build
   ```
3. Exec into the running container:
   ```bash
   docker-compose exec rev-tools /bin/bash
   ```
4. Example tool commands inside the container:
   ```bash
   # Firmware analysis
   binwalk firmware.bin

   # Entropy analysis (saves log to /workspace/out/)
   python3 analyze_entropy.py firmware.bin --out /workspace/out

   # Pull firmware from a device over SSH
   python3 parse_firmware.py --method ssh --host 192.168.1.1 --user admin --pass secret \
       --cmd "dd if=/dev/mtd0 of=/tmp/fw.bin bs=64k" --get /tmp/fw.bin

   # Pull firmware over HTTP
   python3 parse_firmware.py --method http --url http://192.168.1.1/firmware.bin

   # GDB with Pwndbg (auto-loads)
   gdb ./binary

   # Ghidra headless analysis
   analyzeHeadless /workspace/project -import /workspace/binary
   ```

---

## Python Scripts

### `analyze_entropy.py`

Runs Binwalk entropy analysis (`-E`) on a firmware file and optionally saves the output log.

```
usage: analyze_entropy.py [-h] [--out OUT] firmware

positional arguments:
  firmware    Path to firmware binary

optional arguments:
  --out OUT   Output directory for the entropy log
```

### `parse_firmware.py`

Pulls a firmware image from a device over SSH or HTTP.

```
usage: parse_firmware.py [-h] [--method {ssh,http}] [--host HOST] [--user USER]
                         [--pass PASSWORD] [--out OUT] [--url URL]
                         [--cmd CMD] [--get GET]

optional arguments:
  --method    Transport method: ssh (default) or http
  --host      Device IP address (SSH only)
  --user      SSH username (SSH only)
  --pass      SSH password (SSH only)
  --out       Local output directory (default: ./firmware_dumps)
  --url       Firmware URL (HTTP only)
  --cmd       Remote command to run before download, e.g. "dd if=/dev/mtd0 of=/tmp/fw.bin bs=64k"
  --get       Remote file path to download via SFTP, e.g. /tmp/fw.bin
```

---

## AWS Deployment

### On EC2

1. Launch an EC2 instance (Ubuntu 22.04 AMI). Use at least a **t3.medium** (2 vCPU, 4 GB RAM) to satisfy Ghidra's memory requirements.
2. Install Docker and Compose:
   ```bash
   sudo apt update
   sudo apt install docker.io docker-compose -y
   sudo usermod -aG docker ubuntu   # or your username
   ```
3. Copy project files to the instance:
   ```bash
   scp -r . ubuntu@<ec2-ip>:/home/ubuntu/rev-tools
   ```
4. Build and run in detached mode:
   ```bash
   cd rev-tools
   docker-compose up --build -d
   ```
5. Exec in:
   ```bash
   docker-compose exec rev-tools /bin/bash
   ```
6. Monitor resource usage via AWS CloudWatch on the EC2 instance.

### On ECS (Advanced)

Use AWS ECS with Docker Compose integration.

1. Install the AWS CLI and Docker ECS plugin.
2. Create an ECS context:
   ```bash
   docker context create ecs my-ecs-context
   ```
3. Deploy:
   ```bash
   docker compose --context my-ecs-context up
   ```

This runs the service on Fargate. When configuring the task definition, allocate at least **1 vCPU and 4 GB memory** — the previous recommendation of 0.5 vCPU / 512 MB is insufficient for Ghidra and will cause the container to OOM crash.

### Integrating with AWS Lambda

The container includes `boto3` for Python scripts to invoke Lambda functions, allowing specific workloads to be offloaded to serverless compute.

1. **Configure AWS Access**: On EC2, attach an IAM role to the instance with `lambda:InvokeFunction` permissions.

   Example policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "lambda:InvokeFunction",
         "Resource": "arn:aws:lambda:<region>:<account-id>:function:<function-name>"
       }
     ]
   }
   ```

2. **Invoke from Python**:
   ```python
   import boto3
   client = boto3.client('lambda', region_name='us-east-1')
   response = client.invoke(
       FunctionName='my-function',
       InvocationType='RequestResponse',
       Payload=b'{"key": "value"}'
   )
   print(response['Payload'].read())
   ```

---

## Updating Ghidra

The Dockerfile downloads a pinned Ghidra release. To upgrade, update the download URL in the `Dockerfile` builder stage to the desired release from the [Ghidra GitHub releases page](https://github.com/NationalSecurityAgency/ghidra/releases).
