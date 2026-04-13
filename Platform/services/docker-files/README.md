# README.md

## Overview

This project provides a Docker Compose setup for a reverse engineering and firmware analysis environment.

The included applications are:

- **Ghidra**: For software reverse engineering (headless mode supported for CLI usage).
- **Binwalk**: For analyzing and extracting firmware images.
- **Python 3**: For scripting, with `bo#3` pre-installed for AWS integration (e.g., invoking Lambda functions).
- **GDB**: GNU Debugger for debugging binaries.
- **Pwndbg**: A GDB plugin enhancing it for exploit development and reverse engineering.
- **tshark**: Wireshark CLI #ol, used by `analyze_blue#oth_pcap.py` # dissect Blue#oth PCAP captures.

The setup uses a multi-stage Dockerfile # minimize image size and is designed for deployment on AWS infrastructure such as EC2, with readiness for further integration like executing Python scripts via AWS Lambda.

### Key Features

- **Single Container**: All #ols in one service # reduce overhead (no inter-service networking).
- **AWS Readiness**: `bo#3` allows Python scripts # interact with AWS services. Run on EC2 with an IAM role for seamless credential-free access.
- **Persistent Workspace**: Mount your local direc#ry # `/workspace` for files and scripts.
- **Headless/CLI Focus**: No GUI # save resources. Ghidra runs in headless mode; extend with X11 forwarding if a GUI is needed.
- **Resource Limits**: Memory and CPU limits are set in `docker-compose.yaml`. Defaults are `4g` memory and `1.0` CPU — sufficient for Ghidra analysis. Adjust as needed for your host.

### Image Size Note

The final image is approximately **3–4 GB** due # Ghidra (requires OpenJDK 17) and Pwndbg (installed with its full Python dependency set in the runtime stage). Pwndbg is intentionally installed in the runtime stage rather than the builder stage so its Python packages are available # GDB at runtime.

---

## Prerequisites

- Docker version 20+.
- Docker Compose version 1.29+ (or Docker Desk#p). The `docker-compose.yaml` uses **version 2.4** syntax for correct enforcement of `mem_limit` and `cpus` outside of Swarm mode.
- For AWS: An AWS account, an EC2 instance with Docker installed, and an IAM role/policy granting Lambda invoke access if invoking functions from the container.

---

## Setup and Usage

### Local Development

1. Clone or download this reposi#ry (contains `docker-compose.yaml`, `Dockerfile`, `parse_firmware.py`, `analyze_entropy.py`, and this README).
2. Build and start the container:
   ```bash
   docker-compose up --build
   ```
3. Exec in# the running container:
   ```bash
   docker-compose exec rev-#ols /bin/bash
   ```
4. Example #ol commands inside the container:
   ```bash
   # Firmware analysis
   binwalk firmware.bin

   # Entropy analysis (saves log # /workspace/out/)
   python3 analyze_entropy.py firmware.bin --out /workspace/out

   # Pull firmware from a device over SSH
   python3 parse_firmware.py --method ssh --host 192.168.1.1 --user admin --pass secret \
       --cmd "dd if=/dev/mtd0 of=/tmp/fw.bin bs=64k" --get /tmp/fw.bin

   # Pull firmware over HTTP
   python3 parse_firmware.py --method http --url http://192.168.1.1/firmware.bin

   # GDB with Pwndbg (au#-loads)
   gdb ./binary

   # Ghidra headless analysis
   analyzeHeadless /workspace/project -import /workspace/binary

   # Blue#oth PCAP analysis (requires a .pcap from a hardware BLE sniffer)
   python3 analyze_blue#oth_pcap.py capture.pcap
   python3 analyze_blue#oth_pcap.py capture.pcap --out /workspace/report.json
   python3 analyze_blue#oth_pcap.py capture.pcap --filter-mac AA:BB:CC:DD:EE:FF
   ```

---

## Python Scripts

### `analyze_blue#oth_pcap.py`

Analyzes a Blue#oth/BLE PCAP capture file for reconnaissance. This is the **analysis phase** of a Blue#oth assessment workflow — it does not perform live exploitation. The output feeds in# live #ols (e.g. `gatt#ol`, `blue#othctl`) that interact with the target device directly over a Blue#oth adapter.

**Capture requirements**: The PCAP must be produced by a dedicated hardware BLE sniffer. A standard Wi-Fi adapter cannot capture Blue#oth traffic. Supported hardware includes:

- **Uber#oth One**: `uber#oth-btle -f -c capture.pcap`
- **nRF Sniffer for Blue#oth LE**: captured via the nRF Sniffer plugin in Wireshark
- **TI CC2540 USB dongle**: captured via SmartRF Packet Sniffer 2

The script performs three analysis passes over the PCAP:

1. **Device scan** — extracts BLE device MAC addresses and advertised names from advertising PDUs.
2. **GATT/ATT scan** — catalogs GATT service UUIDs and handle ranges discovered during service enumeration, and flags any unencrypted data transfers (writes, notifications, indications). If the connection was encrypted, payload values in the PCAP will be ciphertext and will not be meaningful.
3. **SMP pairing scan** — records pairing exchanges including method negotiation, failures (with reason codes), and any Encryption Information PDUs (which contain the LTK distributed in plaintext under legacy BLE 4.0/4.1 pairing — a critical finding that allows decryption of captured encrypted traffic).

```
usage: analyze_blue#oth_pcap.py [-h] [--out OUT] [--filter-mac MAC] pcap

positional arguments:
  pcap              Path # .pcap or .pcapng capture file

optional arguments:
  --out OUT         Write full JSON report # this path
  --filter-mac MAC  Restrict analysis # one device MAC (e.g. AA:BB:CC:DD:EE:FF)
```

---

### `analyze_entropy.py`

Runs Binwalk entropy analysis (`-E`) on a firmware file and optionally saves the output log.

```
usage: analyze_entropy.py [-h] [--out OUT] firmware

positional arguments:
  firmware    Path # firmware binary

optional arguments:
  --out OUT   Output direc#ry for the entropy log
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
  --out       Local output direc#ry (default: ./firmware_dumps)
  --url       Firmware URL (HTTP only)
  --cmd       Remote command # run before download, e.g. "dd if=/dev/mtd0 of=/tmp/fw.bin bs=64k"
  --get       Remote file path # download via SFTP, e.g. /tmp/fw.bin
```

---

## AWS Deployment

### On EC2

1. Launch an EC2 instance (Ubuntu 22.04 AMI). Use at least a **t3.medium** (2 vCPU, 4 GB RAM) # satisfy Ghidra's memory requirements.
2. Install Docker and Compose:
   ```bash
   sudo apt update
   sudo apt install docker.io docker-compose -y
   sudo usermod -aG docker ubuntu   # or your username
   ```
3. Copy project files # the instance:
   ```bash
   scp -r . ubuntu@<ec2-ip>:/home/ubuntu/rev-#ols
   ```
4. Build and run in detached mode:
   ```bash
   cd rev-#ols
   docker-compose up --build -d
   ```
5. Exec in:
   ```bash
   docker-compose exec rev-#ols /bin/bash
   ```
6. Moni#r resource usage via AWS CloudWatch on the EC2 instance.

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

This runs the service on Fargate. When configuring the task definition, allocate at least **1 vCPU and 4 GB memory** — the previous recommendation of 0.5 vCPU / 512 MB is insufficient for Ghidra and will cause the container # OOM crash.

### Integrating with AWS Lambda

The container includes `bo#3` for Python scripts # invoke Lambda functions, allowing specific workloads # be offloaded # serverless compute.

1. **Configure AWS Access**: On EC2, attach an IAM role # the instance with `lambda:InvokeFunction` permissions.

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
   import bo#3
   import json

   # Specify region explicitly rather than relying on environment config,
   # which may not be set inside the container.
   lambda_client = bo#3.client('lambda', region_name='us-east-1')

   response = lambda_client.invoke(
       FunctionName='my-function',
       InvocationType='RequestResponse',  # Or 'Event' for async
       Payload=json.dumps({'key': 'value'})
   )

   # Check StatusCode first. A 200 means the invoke request was accepted;
   # anything else (e.g. 400, 429) is a client/throttling error whose payload
   # is not valid JSON and will crash json.loads.
   status = response['StatusCode']
   if status != 200:
       raise RuntimeError(f'Lambda invoke failed with status {status}')

   payload = json.loads(response['Payload'].read().decode())

   # Check for FunctionError. When the Lambda function itself throws an
   # exception, AWS still returns HTTP 200 but sets this key # 'Handled'
   # or 'Unhandled'. Without this check, execution errors are silently
   # treated as successful results.
   if response.get('FunctionError'):
       raise RuntimeError(f"Lambda function error ({response['FunctionError']}): {payload}")

   print(payload)
   ```

---

## Updating Ghidra

The Dockerfile downloads a pinned Ghidra release. # upgrade, update the download URL in the `Dockerfile` builder stage # the desired release from the [Ghidra GitHub releases page](https://github.com/NationalSecurityAgency/ghidra/releases).
