# platform-ghidra: analysis-base plus a headless Ghidra install.
#
#   docker build -f ghidra/Dockerfile --build-arg BASE_IMAGE=<platform-base base image> -t platform-base:ghidra .
#
# Ghidra 11.1.x is the last line that runs on JDK 17, which is what Debian
# bookworm ships. Scripts call it with analyzeHeadless (on PATH).

ARG BASE_IMAGE
FROM debian:bookworm-slim AS download
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_11.1.2_build/ghidra_11.1.2_PUBLIC_20240709.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget unzip ca-certificates \
 && wget -q "$GHIDRA_URL" -O /tmp/ghidra.zip \
 && unzip -q /tmp/ghidra.zip -d /opt \
 && mv /opt/ghidra_* /opt/ghidra \
 && rm /tmp/ghidra.zip

FROM ${BASE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/*
COPY --from=download /opt/ghidra /opt/ghidra
ENV GHIDRA_INSTALL_DIR=/opt/ghidra \
    PATH="/opt/ghidra/support:${PATH}"
