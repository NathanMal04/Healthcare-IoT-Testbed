# platform-notebook: the JupyterLab layer for notebook sessions.
#
# Never run on its own. A session task's init container copies /opt/notebook
# out of this image into a shared volume, which is mounted read-only at the
# same path in the environment's container, and that container runs
# /opt/notebook/session.py. So any environment version can be opened as a
# notebook, including ones built before notebooks existed, and script images
# don't carry JupyterLab.
#
# This works because every environment is built FROM platform-base or
# platform-ghidra, both python:3.12-slim-bookworm: the venv's python is a
# symlink to /usr/local/bin/python, which resolves to the environment's own
# interpreter, and --system-site-packages makes the environment's packages
# (scapy, lief, catalog items, platform_sdk...) importable in notebooks.
#
# Build from Platform/services/containers/:
#   docker build -f notebook/Dockerfile -t platform-base:notebook .

FROM python:3.12-slim-bookworm

RUN python -m venv --system-site-packages /opt/notebook \
 && /opt/notebook/bin/pip install --no-cache-dir \
      "jupyterlab>=4.2,<5" \
      "ipykernel>=6.29" \
      "ipywidgets>=8.1" \
 && mkdir -p /opt/notebook/share/jupyter/lab/settings

# Sessions have no internet: no news or update checks.
COPY notebook/overrides.json /opt/notebook/share/jupyter/lab/settings/overrides.json
COPY notebook/session.py /opt/notebook/session.py
COPY notebook/platform_notebook.py /opt/notebook/lib/python3.12/site-packages/platform_notebook.py
