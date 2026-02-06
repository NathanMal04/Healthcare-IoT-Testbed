# Healthcare IoT Vulnerability Testbed

## Overview
This repository contains the source code and infrastructure for the **Healthcare IoT Vulnerability Testbed** senior design project.  
The goal of this project is to provide a controlled platform for collecting, analyzing, and testing the security of healthcare and IoT devices.

## High-Level Architecture
- AWS VPC with **Public**, **Private**, and **Database** subnets
- Public subnet hosts the web interface
- Private subnet hosts backend services (ECS, Lambda)
- Database subnet hosts RDS for metadata storage
- S3 (outside the VPC) stores user-uploaded artifacts



### Folder Responsibilities
- **infra/**  
  Source of truth for all AWS infrastructure. No manual changes in the AWS console.

- **services/**  
  Application code that runs on AWS (containers and Lambda functions).

- **data-contracts/**  
  Defines shared data formats used across services (API schemas, DB schemas).

- **scripts/**  
  Non-deployable helper scripts for development and operations.

- **docs/**  
  Project documentation, diagrams, and operational guides.

## Repository Structure

```
platform/
  infra/            # Infrastructure as Code
  services/         # Deployable services
  scripts/          # Helper scripts
docs/               # Architecture docs, runbooks, decision records
.devcontainer/      # Standardized development environment
```

## Development Environment
This project uses **VS Code Dev Containers** to standardize tooling across the team.

### Requirements
- Docker
- VS Code
- VS Code Dev Containers extension
- AWS credentials (via IAM Identity Center or named profiles)

### Getting Started
1. Clone the repository
2. Open the repo in VS Code
3. Reopen the project in the provided container
    - Open the Command Pallette (`Ctrl+Shift+P`)
    - Select **`Dev Containers: Reopen in Container`**
4. Log in to AWS SSO and verify access:
    ```bash
    asw sso login
    aws sts get-caller-identity