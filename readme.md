#README.md

##Overview

This project provides a Docker Compose setup for a lightweight reverse engineering and analysis environment. 

The included applications are:

- **Ghidra**: For software reverse engineering (headless mode supported for CLI usage).
- **Binwalk**: For analyzing and extracting firmware images.
- **Python 3**: For scripting, with `boto3` pre-installed for AWS integration (e.g., invoking Lambda functions).
- **GDB**: GNU Debugger for debugging binaries.
- **Pwndbg**: A GDB plugin enhancing it for exploit development and reverse engineering.

The setup is optimized for low resource usage (e.g., multi-stage Dockerfile to minimize image size, resource limits in Compose). 
It's designed for deployment on AWS infrastructure, such as EC2 instances, 
with readiness for further integration like executing specific Python scripts via AWS Lambda.

###Key Features
- **Lightweight**: Built on Ubuntu 22.04 with minimal packages; final image ~1.5-2GB.
- **Single Container**: All tools in one service to reduce overhead (no inter-service networking).
- **AWS Readiness**: `boto3` allows Python scripts to interact with AWS services. Run on EC2 with an IAM role for seamless access.
- **Persistent Workspace**: Mount your local directory to `/workspace` for files/scripts.
- **Headless/CLI Focus**: No GUI to save resources; extend if needed (e.g., add X11 forwarding).

##Prerequisites

- Docker installed (version 20+).
- Docker Compose (version 1.29+ or Docker Desktop).
- For AWS: An AWS account, EC2 instance with Docker, and IAM role/policy for Lambda access if invoking from container.

##Setup and Usage

###Local Development
1. Clone or download this repository (contains `docker-compose.yml`, `Dockerfile`, and this README).
2. Build and start the container by running: "docker-compose up --build"
- This builds the image and starts a bash shell.
3. Interact with tools:
- Exec into running container: `docker-compose exec rev-tools /bin/bash`.
- Example commands:
  - Binwalk: `binwalk firmware.bin`
  - GDB with Pwndbg: `gdb ./binary` (Pwndbg auto-loads).
  - Ghidra Headless: `analyzeHeadless /workspace/project -import /workspace/binary`
  - Python: `python3 script.py`

###AWS Deployment
Deploy this on AWS for cloud-based analysis. Recommended: EC2 (for persistent setup) or ECS (for container orchestration).

####On EC2
1. Launch an EC2 instance (e.g., t3.micro for low resources; Ubuntu 22.04 AMI).
2. Install Docker & Compose on the instance by running:
sudo apt update
sudo apt install docker.io docker-compose -y
sudo usermod -aG docker ubuntu  #Or your user
3. Copy files to EC2 (e.g., via SCP or Git)by running:
scp -r . ubuntu@ec2-instance:/home/ubuntu/rev-tools
4. On EC2, build and run:
cd rev-tools
docker-compose up --build -d  #Detached mode
5. Access: SSH to EC2 and exec: `docker-compose exec rev-tools /bin/bash`.
6. Resource Monitoring: Use AWS CloudWatch to monitor EC2 CPU/memory (container limits help prevent overuse).

####On ECS (Advanced)
- Use AWS ECS with Docker Compose integration (via `docker compose up` with ECS context).
1. Install AWS CLI and Docker ECS plugin.
2. Set ECS context: `docker context create ecs my-ecs-context`.
3. Deploy: `docker compose --context my-ecs-context up`.
- This runs the service on Fargate (serverless) for even lighter management. 
  Adjust task definitions for resources (e.g., 0.5 vCPU, 512MB).

####Integrating with AWS Lambda
The container includes `boto3` for Python scripts to invoke Lambda functions. 
This allows offloading specific script executions to Lambda (e.g., for scalability or serverless compute).

1. **Configure AWS Access**:
- On EC2: Attach an IAM role to the instance with `Lambda_Invoke` permissions.
- Policy Example:
  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "lambda:InvokeFunction",
        "Resource": "arn:aws:lambda:region:account:function:function-name"
      }
    ]
  }