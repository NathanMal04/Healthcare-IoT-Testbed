# analysis-base: the default environment for L1/L2 scripts, and the source of
# the /opt/platform wrapper (launcher + SDK) that every script image gets.
#
# Build from Platform/services/containers/ (the context needs launcher/ and sdk/):
#   docker build -f base/Dockerfile -t platform-base:base .
#
# Tool choices follow the older analysis image in services/docker-files/,
# minus the interactive tools (gdb/pwndbg) and Ghidra, which are catalog
# items or the platform-ghidra environment.

FROM golang:1.23-bookworm AS launcher
WORKDIR /src
COPY launcher/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/launcher .

FROM python:3.12-slim-bookworm

# tshark asks whether non-root users may capture; answer no so the build
# doesn't wait for input. Scripts only read capture files.
RUN echo "wireshark-common wireshark-common/install-setuid boolean false" | debconf-set-selections \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      tshark \
      binwalk \
      file \
      libmagic1 \
      xxd \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      "scapy>=2.5" \
      "dpkt>=1.9" \
      "pyshark>=0.6" \
      "lief>=0.14" \
      "pyelftools>=0.31" \
      "capstone>=5.0" \
      "yara-python>=4.5" \
      "pandas>=2.2" \
      "unblob>=24.0" \
      "python-magic>=0.4"

COPY --from=launcher /out/launcher /opt/platform/launcher
COPY sdk/ /opt/platform/sdk/

ENV PYTHONPATH=/opt/platform/sdk \
    PYTHONUNBUFFERED=1 \
    PLATFORM_WORK_DIR=/work

RUN mkdir -p /work /app
WORKDIR /app

# Runs the script once per work unit; see launcher/main.go.
ENTRYPOINT ["/opt/platform/launcher"]
