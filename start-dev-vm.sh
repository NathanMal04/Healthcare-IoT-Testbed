#!/usr/bin/env bash
# ==============================================================================
# start-dev-vm.sh — Idempotent NixOS VM + DevContainer launcher with GUI support
# ==============================================================================

set -euo pipefail
xhost +local:

# ------------------------------------------------------------------ Colors ----
if [[ -t 2 ]]; then
    RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    BLUE=$'\033[34m'; CYAN=$'\033[36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; RESET=''
fi

log()  { printf '%s[%s]%s %s\n'  "$CYAN"   "$(date +%H:%M:%S)" "$RESET" "$*" >&2; }
ok()   { printf '%s✔%s %s\n'     "$GREEN"  "$RESET"            "$*"      >&2; }
warn() { printf '%s⚠%s %s\n'     "$YELLOW" "$RESET"            "$*"      >&2; }
die()  { printf '%s✘%s %s\n'     "$RED"    "$RESET"            "$*"      >&2; exit "${2:-1}"; }

# ------------------------------------------------------------- Configuration --
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
CONFIG_NIX="${REPO_ROOT}/configuration.nix"
DEVCONTAINER_DIR="${REPO_ROOT}/.devcontainer"
DEVCONTAINER_JSON="${DEVCONTAINER_DIR}/devcontainer.json"

# VM tuning (override via environment)
VM_MEMORY_MB="${VM_MEMORY_MB:-8192}"
VM_CORES="${VM_CORES:-4}"
VM_DISK_GB="${VM_DISK_GB:-40}"
VM_HOST_PORT_SSH="${VM_HOST_PORT_SSH:-2222}"
VM_HOST_PORT_WEB="${VM_HOST_PORT_WEB:-3000}"
VM_HOST_PORT_API="${VM_HOST_PORT_API:-8000}"
VM_HOSTNAME="dev-vm"

VM_DISPLAY=":0"

WORKSPACE_BASENAME="$(basename "$REPO_ROOT")"
CONTAINER_NAME="$(printf '%s' "$WORKSPACE_BASENAME" | tr '[:upper:]' '[:lower:]')_devcontainer"

# ---------------------------------------------------------- Runtime state -----
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/healthcare-iot-vm-$$"
mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

VM_PID_FILE="${RUNTIME_DIR}/vm.pid"
SOCAT_HOST_PID_FILE="${RUNTIME_DIR}/socat-host.pid"

CLEANUP_DONE=0
XHOST_ADDED=0
SSH_KEY_PATH="${RUNTIME_DIR}/id_ed25519"
SSH_PUBKEY=""

# ---------------------------------------------------------- Ephemeral SSH -----
ssh-keygen -t ed25519 -N "" -f "$SSH_KEY_PATH" -C "healthcare-iot-vm-$$" >/dev/null 2>&1 \
    || die "ssh-keygen failed"
SSH_PUBKEY="$(cat "${SSH_KEY_PATH}.pub")"

SSH_OPTS=(
    -i "$SSH_KEY_PATH"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o ConnectTimeout=5
    -p "$VM_HOST_PORT_SSH"
)

# --------------------------------------------------------------- Cleanup ------
cleanup() {
    local exit_code=$?
    (( CLEANUP_DONE )) && exit "$exit_code"
    CLEANUP_DONE=1
    log "Cleaning up..."

    if (( XHOST_ADDED )); then
        xhost -local: >/dev/null 2>&1 || true
    fi

    if [[ -f "$SOCAT_HOST_PID_FILE" ]]; then
        local sp
        sp="$(cat "$SOCAT_HOST_PID_FILE" 2>/dev/null || true)"
        [[ -n "$sp" ]] && kill "$sp" 2>/dev/null || true
        rm -f "$SOCAT_HOST_PID_FILE"
    fi

    if [[ -f "$VM_PID_FILE" ]]; then
        local vmpid
        vmpid="$(cat "$VM_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$vmpid" ]] && kill -0 "$vmpid" 2>/dev/null; then
            log "Stopping VM (pid $vmpid)..."
            kill "$vmpid" 2>/dev/null || true
            for _ in {1..20}; do
                kill -0 "$vmpid" 2>/dev/null || break
                sleep 0.2
            done
            kill -0 "$vmpid" 2>/dev/null && kill -9 "$vmpid" 2>/dev/null || true
        fi
        rm -f "$VM_PID_FILE"
    fi

    rm -rf "$RUNTIME_DIR"
    ok "Cleanup complete."
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------ Pre-flight ------
preflight() {
    log "Running pre-flight checks..."

    local -a missing=()
    for cmd in nix nixos-rebuild qemu-system-x86_64 devcontainer \
               xhost xauth ssh ssh-keygen socat; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    if (( ${#missing[@]} )); then
        die "Missing required host tools: ${missing[*]}
  Install hints:
    nix / nixos-rebuild : https://nixos.org/download
    qemu-system-x86_64  : apt install qemu-system-x86   (or nix-shell -p qemu)
    devcontainer        : npm install -g @devcontainers/cli
    xhost / xauth       : apt install x11-xserver-utils xauth
    socat               : apt install socat"
    fi

    [[ -f "$CONFIG_NIX" ]]        || die "configuration.nix not found at $CONFIG_NIX"
    [[ -f "$DEVCONTAINER_JSON" ]] || die ".devcontainer/devcontainer.json not found at $DEVCONTAINER_JSON"

    if ! docker info >/dev/null 2>&1 && ! podman info >/dev/null 2>&1; then
        die "No container runtime reachable. Start Docker or podman first."
    fi
    ok "Pre-flight checks passed."
}

# --------------------------------------------------------------- Display ------
DISPLAY_BACKEND=""
HOST_DISPLAY_NUM=""

detect_display_backend() {
    if [[ -n "${WAYLAND_DISPLAY:-}" && -S "${XDG_RUNTIME_DIR:-/tmp}/${WAYLAND_DISPLAY}" ]]; then
        DISPLAY_BACKEND="wayland"
    elif [[ -n "${DISPLAY:-}" && -S "/tmp/.X11-unix/X${DISPLAY#*:}" ]]; then
        DISPLAY_BACKEND="x11"
    elif [[ -n "${DISPLAY:-}" ]]; then
        DISPLAY_BACKEND="x11"
        warn "DISPLAY=$DISPLAY but no unix socket at /tmp/.X11-unix/X${DISPLAY#*:}"
    else
        die "No DISPLAY or WAYLAND_DISPLAY set. Run from a graphical session."
    fi
    HOST_DISPLAY_NUM="${DISPLAY#*:}"
    HOST_DISPLAY_NUM="${HOST_DISPLAY_NUM%%.*}"
    [[ -n "$HOST_DISPLAY_NUM" ]] || HOST_DISPLAY_NUM="0"
    export DISPLAY_BACKEND HOST_DISPLAY_NUM
    log "Display backend: ${BOLD}${DISPLAY_BACKEND}${RESET} (host display :${HOST_DISPLAY_NUM}, VM will see ${VM_DISPLAY})"
}

prepare_x11_auth() {
    export XAUTHORITY="${RUNTIME_DIR}/.Xauthority"
    : > "$XAUTHORITY"

    if command -v xauth >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
        xauth nextract - "$DISPLAY" > "$XAUTHORITY" 2>/dev/null \
            || xauth generate "$DISPLAY" . trusted 2>/dev/null \
            || true
    fi

    if xhost +local: >/dev/null 2>&1; then
        XHOST_ADDED=1
        ok "xhost +local: accepted"
    else
        warn "xhost +local: failed; GUI apps may be blocked by X11 auth"
    fi
}

# --------------------------------------------------------------- NixOS VM -----
build_vm() {
    log "Writing VM config..."
    local vm_nix="${RUNTIME_DIR}/vm.nix"
    cat > "$vm_nix" <<EOF
{ config, pkgs, lib, modulesPath, ... }:
{
  imports = [ (modulesPath + "/virtualisation/qemu-vm.nix") ];

  # ── VM resources ────────────────────────────────────────────────────────
  virtualisation = {
    memorySize = ${VM_MEMORY_MB};
    cores      = ${VM_CORES};
    diskSize   = ${VM_DISK_GB} * 1024;   # MB

    # ── Host↔Guest port forwarding (SSH + project services) ─────────────
    forwardPorts = [
      { from = "host"; host.address = "127.0.0.1";
        host.port = ${VM_HOST_PORT_SSH}; guest.port = 22; }
      { from = "host"; host.address = "127.0.0.1";
        host.port = ${VM_HOST_PORT_WEB}; guest.port = ${VM_HOST_PORT_WEB}; }
      { from = "host"; host.address = "127.0.0.1";
        host.port = ${VM_HOST_PORT_API}; guest.port = ${VM_HOST_PORT_API}; }
    ];

    # ── Host repo → /workspaces/<basename> inside VM ────────────────────
    sharedDirectories.workspace = {
      source = "${REPO_ROOT}";
      target = "/workspaces/${WORKSPACE_BASENAME}";
    };

    # ── Headless QEMU: user interacts via SSH, GUI goes over socat bridge ─
    qemu.options = [ "-display" "none" ];
  };

  networking.hostName = "${VM_HOSTNAME}";

  services.openssh = {
    enable = true;
    settings.PasswordAuthentication = false;
    settings.PermitRootLogin        = "no";
  };

  virtualisation.docker.enable = true;

  environment.systemPackages = with pkgs; [
    docker nodejs python3 gnumake gcc git curl
    xauth xhost openssh socat devcontainer
  ];

  # ── Container-host user (MUST be a normal user for SSH to work) ────────
  users.users.nixosvmtest = {
    isNormalUser = true;
    extraGroups  = [ "docker" "wheel" ];
    openssh.authorizedKeys.keys = [ "${SSH_PUBKEY}" ];
  };

  # ── Passwordless sudo for the wheel group (needed for socat bridge) ────
  security.sudo.wheelNeedsPassword = false;

  system.stateVersion = "24.11";
}
EOF

    log "Building NixOS VM (channel-based, no flakes)..."
    log "  nixos-config : $vm_nix"
    log "  nixpkgs      : channel:nixos-unstable"

    (
        cd "$REPO_ROOT"
        nixos-rebuild build-vm \
            -I nixos-config="$vm_nix" \
            -I nixpkgs=channel:nixos-unstable
    ) 2>&1 | tee "${RUNTIME_DIR}/build.log" \
        || die "VM build failed. See ${RUNTIME_DIR}/build.log" 2

    VM_RUNNER="${REPO_ROOT}/result/bin/run-${VM_HOSTNAME}-vm"
    [[ -x "$VM_RUNNER" ]] || die "VM runner not found at $VM_RUNNER" 2
    ok "VM build complete: $VM_RUNNER"
}

start_vm() {
    if [[ -f "$VM_PID_FILE" ]] && kill -0 "$(cat "$VM_PID_FILE" 2>/dev/null)" 2>/dev/null; then
        ok "VM already running (pid $(cat "$VM_PID_FILE"))"
        return
    fi

    log "Starting VM in background (output → ${RUNTIME_DIR}/vm.log)..."
    "$VM_RUNNER" >"${RUNTIME_DIR}/vm.log" 2>&1 &
    echo $! > "$VM_PID_FILE"

    log "Waiting for SSH to become reachable..."
    local deadline=$((SECONDS + 180))
    while (( SECONDS < deadline )); do
        if kill -0 "$(cat "$VM_PID_FILE")" 2>/dev/null \
           && ssh "${SSH_OPTS[@]}" nixosvmtest@127.0.0.1 true 2>/dev/null; then
            ok "VM is up (SSH on port $VM_HOST_PORT_SSH)"
            return
        fi
        if ! kill -0 "$(cat "$VM_PID_FILE")" 2>/dev/null; then
            die "VM process exited during boot. Check ${RUNTIME_DIR}/vm.log" 2
        fi
        sleep 2
    done
    die "VM did not become reachable within 180s. Check ${RUNTIME_DIR}/vm.log" 3
}

# ---------------------------------------------------- X11 → VM → container ----
setup_x11_forwarding() {
    log "Setting up X11 forwarding into VM..."

    local host_sock="/tmp/.X11-unix/X${HOST_DISPLAY_NUM}"
    if [[ ! -S "$host_sock" ]]; then
        die "Host X socket not found at $host_sock — is DISPLAY=$DISPLAY correct?" 2
    fi

    pkill -f "socat.*TCP-LISTEN:6000.*UNIX-CONNECT:$host_sock" 2>/dev/null || true
    sleep 0.3

    socat TCP-LISTEN:6000,bind=127.0.0.1,fork,reuseaddr \
          UNIX-CONNECT:"$host_sock" >/dev/null 2>&1 &
    echo $! > "$SOCAT_HOST_PID_FILE"
    sleep 0.5

    if ! kill -0 "$(cat "$SOCAT_HOST_PID_FILE")" 2>/dev/null; then
        die "Host-side socat failed to start (port 6000 busy?)" 2
    fi

    ssh "${SSH_OPTS[@]}" nixosvmtest@127.0.0.1 bash -s <<REMOTE
set -e
sudo mkdir -p /tmp/.X11-unix
sudo chmod 1777 /tmp/.X11-unix
sudo pkill -f 'socat UNIX-LISTEN:/tmp/.X11-unix/X0' 2>/dev/null || true
sleep 0.3
sudo nohup socat \
    UNIX-LISTEN:/tmp/.X11-unix/X0,fork,reuseaddr,mode=1777 \
    TCP:10.0.2.2:6000 \
    >/tmp/socat-x11.log 2>&1 &
disown
sleep 0.5
test -S /tmp/.X11-unix/X0
REMOTE

    if ssh "${SSH_OPTS[@]}" nixosvmtest@127.0.0.1 "test -S /tmp/.X11-unix/X0"; then
        ok "X11 bridge established (host :${HOST_DISPLAY_NUM} → VM ${VM_DISPLAY})"
    else
        die "VM-side X11 bridge failed to create /tmp/.X11-unix/X0" 2
    fi
}

# ---------------------------------------------------------- DevContainer ------
start_devcontainer() {
    log "Starting DevContainer inside VM..."
    ssh "${SSH_OPTS[@]}" nixosvmtest@127.0.0.1 bash -s <<REMOTE
set -euo pipefail
export DISPLAY="${VM_DISPLAY}"
export XAUTHORITY="\$HOME/.Xauthority"
export DOCKER_HOST="unix:///var/run/docker.sock"
cd "/workspaces/${WORKSPACE_BASENAME}"
devcontainer up --workspace-folder . --remove-existing-container
REMOTE
    ok "DevContainer up (name: ${CONTAINER_NAME})"
}

verify_gui() {
    log "Verifying GUI passthrough into container..."
    if ssh "${SSH_OPTS[@]}" nixosvmtest@127.0.0.1 bash -s <<REMOTE >/dev/null 2>&1
set -e
cd "/workspaces/${WORKSPACE_BASENAME}"
devcontainer exec --workspace-folder . -- sh -c 'test -S /tmp/.X11-unix/X0'
REMOTE
    then
        ok "GUI passthrough verified — X11 socket reachable inside container."
    else
        warn "GUI probe failed. Possible causes:"
        warn "  • Container mount of /tmp/.X11-unix missing (check .devcontainer/devcontainer.json mounts)"
        warn "  • Host X server refused connection (run: xhost +local:)"
        warn "  • VM-side socat exited (check: ssh -p ${VM_HOST_PORT_SSH} nixosvmtest@127.0.0.1 cat /tmp/socat-x11.log)"
    fi
}

# ---------------------------------------------------------------- Main --------
main() {
    printf '\n%s╔═══════════════════════════════════════════════════════════════╗%s\n' "$BOLD" "$RESET" >&2
    printf '%s║  Healthcare IoT Testbed — NixOS VM + DevContainer Launcher    ║%s\n' "$BOLD" "$RESET" >&2
    printf '%s╚═══════════════════════════════════════════════════════════════╝%s\n\n' "$BOLD" "$RESET" >&2

    preflight
    detect_display_backend
    prepare_x11_auth
    build_vm
    start_vm
    setup_x11_forwarding
    start_devcontainer
    verify_gui

    printf '\n'
    ok "Everything is up."
    printf '  VM SSH        : ssh -i %s -p %s nixosvmtest@127.0.0.1\n' \
        "$SSH_KEY_PATH" "$VM_HOST_PORT_SSH" >&2
    printf '  DevContainer  : ssh … "devcontainer exec --workspace-folder /workspaces/%s -- bash"\n' \
        "$WORKSPACE_BASENAME" >&2
    printf '  Web UI (host) : http://127.0.0.1:%s\n' "$VM_HOST_PORT_WEB" >&2
    printf '  API  (host)   : http://127.0.0.1:%s\n' "$VM_HOST_PORT_API" >&2
    printf '\nPress Ctrl+C to stop the VM and clean up.\n\n' >&2

    wait "$(cat "$VM_PID_FILE")" || true
}

main "$@"
