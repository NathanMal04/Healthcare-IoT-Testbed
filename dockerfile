#Dockerfile
#
#This Dockerfile builds a lightweight container with the required tools:
#- Python 3 (with pip and boto3 for AWS Lambda integration)
#- GDB (debugger)
#- Pwndbg (GDB plugin)
#- Binwalk (firmware analysis)
#- Ghidra (reverse engineering, headless-capable)
#
#Base: Ubuntu 22.04 – Balanced for size and compatibility (avoids heavier full Ubuntu, but Alpine has issues with some tools like Pwndbg).
#Multi-stage build: Used to separate build dependencies from runtime, reducing final image size.
#No GUI: Keeps resources low; use Ghidra's headless mode for analysis.
#AWS Readiness: boto3 installed for Python scripts to invoke Lambda (e.g., via lambda_client.invoke()).
#Cleanup: Removes caches and temp files to minimize size.

#Stage 1: Builder stage for compiling/installing dependencies.
FROM ubuntu:22.04 AS builder

#Update and install build essentials and tools.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    git \
    wget \
    unzip \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

#Install Pwndbg (requires git and build tools).
RUN git clone https://github.com/pwndbg/pwndbg /pwndbg && \
    cd /pwndbg && \
    ./setup.sh

#Download and extract Ghidra (latest public version as of knowledge; update URL if needed).
RUN wget https://ghidra-sre.org/ghidra_11.0_PUBLIC_20231222.zip -O /tmp/ghidra.zip && \
    unzip /tmp/ghidra.zip -d /opt && \
    mv /opt/ghidra_* /opt/ghidra && \
    rm /tmp/ghidra.zip

#Stage 2: Runtime stage – copy from builder and add minimal runtime deps.
FROM ubuntu:22.04

#Install runtime dependencies only (no build tools to save space).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    gdb \
    binwalk \
    openjdk-17-jre-headless \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

#Copy Pwndbg from builder.
COPY --from=builder /pwndbg /pwndbg
#Set up Pwndbg environment (source it in bashrc for easy use).
RUN echo "source /pwndbg/gdbinit.py" >> /root/.gdbinit

#Copy Ghidra from builder.
COPY --from=builder /opt/ghidra /opt/ghidra
#Set Ghidra paths.
ENV PATH="/opt/ghidra:/opt/ghidra/support:${PATH}"
ENV GHIDRA_INSTALL_DIR="/opt/ghidra"

#Install boto3 for AWS integration (e.g., invoking Lambda from Python scripts).
RUN pip3 install --no-cache-dir boto3

#Default command: bash shell for interaction.
CMD ["/bin/bash"]