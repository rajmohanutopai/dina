#!/usr/bin/env bash
# Manage a disposable DigitalOcean VM for clean Dina plugin installation tests.

set -euo pipefail

VM_NAME="${DINA_TEST_VM_NAME:-dina-plugin-test}"
REGION="${DINA_TEST_VM_REGION:-blr1}"
SIZE="${DINA_TEST_VM_SIZE:-s-2vcpu-4gb}"
IMAGE="${DINA_TEST_VM_IMAGE:-ubuntu-24-04-x64}"
SSH_KEY_NAME="${DINA_TEST_VM_SSH_KEY_NAME:-Dina Digital Ocean Test}"
SSH_PRIVATE_KEY="${DINA_TEST_VM_SSH_KEY:-$HOME/.ssh/dina_digitalocean_test}"
TEST_USER="${DINA_TEST_VM_USER:-dina-test}"
STATE_DIR="${DINA_TEST_VM_STATE_DIR:-$HOME/.config/dina-test-vm}"
STATE_FILE="$STATE_DIR/state"
FIREWALL_NAME="${DINA_TEST_VM_FIREWALL_NAME:-dina-plugin-test-ssh}"
SSH_OPTIONS=(
  -i "$SSH_PRIVATE_KEY"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=8
)

usage() {
  cat <<'EOF'
Usage: scripts/dev/dina-test-vm.sh <command> [options]

Commands:
  doctor                    Check local dependencies and DigitalOcean login.
  adopt <droplet-id|name>   Manage an existing Droplet, secure it, and prepare
                            the non-root test account.
  create                    Create, secure, and prepare a new test Droplet.
  status                    Show the managed Droplet and estimated hourly cost.
  ssh [command ...]         Connect as the non-root test user, or run a command.
  rebuild [--yes]           Wipe and rebuild the managed Droplet with Ubuntu.
  refresh-firewall          Restrict SSH to the current public IPv4 address.
  destroy [--yes]           Delete the Droplet and its test firewall.

One-time prerequisites:
  brew install doctl
  doctl auth init

Defaults can be overridden with DINA_TEST_VM_* environment variables. The
DigitalOcean token remains in doctl's own configuration. This script stores
only the managed Droplet ID and name under ~/.config/dina-test-vm/.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing command '$1'${2:+; $2}"
}

require_tools() {
  require_command doctl "install it with: brew install doctl"
  require_command python3
  require_command ssh
  require_command ssh-keygen
  require_command curl
}

require_auth() {
  doctl account get >/dev/null 2>&1 || die "doctl is not authenticated; run: doctl auth init"
}

validate_config() {
  [[ "$VM_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || die "invalid Droplet name: $VM_NAME"
  [[ "$TEST_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid test username: $TEST_USER"
  [[ "$FIREWALL_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || die "invalid firewall name: $FIREWALL_NAME"
}

state_get() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] || return 1
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$STATE_FILE"
}

write_state() {
  local id="$1"
  local name="$2"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  {
    printf 'droplet_id=%s\n' "$id"
    printf 'droplet_name=%s\n' "$name"
  } >"$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

droplet_from_list() {
  local selector="$1"
  doctl compute droplet list --output json | python3 -c '
import json, sys

selector = sys.argv[1]
for droplet in json.load(sys.stdin):
    if str(droplet.get("id")) != selector and droplet.get("name") != selector:
        continue
    public_ip = next(
        (item.get("ip_address", "") for item in droplet.get("networks", {}).get("v4", [])
         if item.get("type") == "public"),
        "",
    )
    print("{}\t{}\t{}\t{}".format(
        droplet["id"], droplet["name"], public_ip, droplet.get("status", "")
    ))
    break
' "$selector"
}

droplet_from_id() {
  local id="$1"
  doctl compute droplet get "$id" --output json | python3 -c '
import json, sys

value = json.load(sys.stdin)
droplet = value[0] if isinstance(value, list) else value
public_ip = next(
    (item.get("ip_address", "") for item in droplet.get("networks", {}).get("v4", [])
     if item.get("type") == "public"),
    "",
)
print("{}\t{}\t{}\t{}".format(
    droplet["id"], droplet["name"], public_ip, droplet.get("status", "")
))
'
}

current_droplet() {
  local id
  id="$(state_get droplet_id || true)"
  if [[ -n "$id" ]]; then
    droplet_from_id "$id" 2>/dev/null || true
    return
  fi
  droplet_from_list "$VM_NAME"
}

require_droplet() {
  local details
  details="$(current_droplet)"
  [[ -n "$details" ]] || die "no managed Droplet; run 'create' or 'adopt <id-or-name>'"
  printf '%s\n' "$details"
}

ssh_key_id() {
  doctl compute ssh-key list --output json | python3 -c '
import json, sys

name = sys.argv[1]
for key in json.load(sys.stdin):
    if key.get("name") == name:
        print(key["id"])
        break
' "$SSH_KEY_NAME"
}

firewall_id() {
  doctl compute firewall list --output json | python3 -c '
import json, sys

name = sys.argv[1]
for firewall in json.load(sys.stdin):
    if firewall.get("name") == name:
        print(firewall["id"])
        break
' "$FIREWALL_NAME"
}

public_ipv4() {
  local ip
  ip="${DINA_TEST_VM_SSH_SOURCE_IP:-}"
  if [[ -z "$ip" ]]; then
    ip="$(curl --fail --silent --show-error --max-time 10 https://api.ipify.org)"
  fi
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "could not determine a valid public IPv4 address"
  printf '%s\n' "$ip"
}

replace_firewall() {
  local droplet_id="$1"
  local source_ip existing
  source_ip="$(public_ipv4)"
  existing="$(firewall_id)"
  if [[ -n "$existing" ]]; then
    doctl compute firewall delete "$existing" --force >/dev/null
  fi

  doctl compute firewall create \
    --name "$FIREWALL_NAME" \
    --droplet-ids "$droplet_id" \
    --inbound-rules "protocol:tcp,ports:22,address:$source_ip/32" \
    --outbound-rules \
      "protocol:icmp,address:0.0.0.0/0 protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0" \
    >/dev/null
  printf 'SSH firewall restricted to %s/32.\n' "$source_ip"
}

wait_for_ssh() {
  local user="$1"
  local ip="$2"
  local attempt
  for attempt in $(seq 1 60); do
    if ssh "${SSH_OPTIONS[@]}" -o BatchMode=yes "$user@$ip" true >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  die "SSH did not become ready for $user@$ip"
}

remove_stale_host_key() {
  local ip="$1"
  ssh-keygen -R "$ip" >/dev/null 2>&1 || true
}

prepare_test_user() {
  local ip="$1"
  [[ -f "$SSH_PRIVATE_KEY" ]] || die "SSH private key not found: $SSH_PRIVATE_KEY"
  wait_for_ssh root "$ip"
  ssh "${SSH_OPTIONS[@]}" "root@$ip" "TEST_USER='$TEST_USER' bash -s" <<'REMOTE'
set -euo pipefail

if ! id -u "$TEST_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' "$TEST_USER"
  usermod -aG sudo "$TEST_USER"
fi

install -d -m 700 -o "$TEST_USER" -g "$TEST_USER" "/home/$TEST_USER/.ssh"
install -m 600 -o "$TEST_USER" -g "$TEST_USER" \
  /root/.ssh/authorized_keys "/home/$TEST_USER/.ssh/authorized_keys"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$TEST_USER" >"/etc/sudoers.d/$TEST_USER"
chmod 440 "/etc/sudoers.d/$TEST_USER"

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw --force enable >/dev/null
REMOTE
  wait_for_ssh "$TEST_USER" "$ip"
  printf 'Prepared non-root account %s@%s.\n' "$TEST_USER" "$ip"
}

confirm_destructive() {
  local action="$1"
  local answer
  if [[ "${2:-}" == "--yes" ]]; then
    return
  fi
  if [[ ! -t 0 ]]; then
    die "$action requires --yes in a non-interactive shell"
  fi
  read -r -p "Type '$action' to confirm: " answer
  [[ "$answer" == "$action" ]] || die "$action cancelled"
}

cmd_doctor() {
  require_tools
  require_auth
  [[ -f "$SSH_PRIVATE_KEY" ]] || die "SSH private key not found: $SSH_PRIVATE_KEY"
  local key_id
  key_id="$(ssh_key_id)"
  [[ -n "$key_id" ]] || die "DigitalOcean SSH key '$SSH_KEY_NAME' was not found"
  printf 'doctl authentication: ok\n'
  printf 'DigitalOcean SSH key: %s (id %s)\n' "$SSH_KEY_NAME" "$key_id"
  printf 'Local private key: %s\n' "$SSH_PRIVATE_KEY"
}

cmd_adopt() {
  local selector="${1:-}"
  [[ -n "$selector" ]] || die "adopt requires a Droplet ID or name"
  local details id name ip status
  details="$(droplet_from_list "$selector")"
  [[ -n "$details" ]] || die "Droplet '$selector' was not found"
  IFS=$'\t' read -r id name ip status <<<"$details"
  [[ -n "$ip" ]] || die "Droplet '$name' does not have a public IPv4 address yet"
  write_state "$id" "$name"
  replace_firewall "$id"
  prepare_test_user "$ip"
  printf 'Adopted Droplet %s (%s, %s).\n' "$name" "$id" "$status"
}

cmd_create() {
  local existing key_id details id name ip status
  existing="$(current_droplet)"
  [[ -z "$existing" ]] || die "a managed Droplet already exists; use status, rebuild, or destroy"
  key_id="$(ssh_key_id)"
  [[ -n "$key_id" ]] || die "DigitalOcean SSH key '$SSH_KEY_NAME' was not found"

  doctl compute droplet create "$VM_NAME" \
    --region "$REGION" \
    --size "$SIZE" \
    --image "$IMAGE" \
    --ssh-keys "$key_id" \
    --wait \
    >/dev/null

  details="$(droplet_from_list "$VM_NAME")"
  [[ -n "$details" ]] || die "Droplet was created but could not be found"
  IFS=$'\t' read -r id name ip status <<<"$details"
  write_state "$id" "$name"
  replace_firewall "$id"
  prepare_test_user "$ip"
  printf 'Created Droplet %s (%s, %s) at %s.\n' "$name" "$id" "$status" "$ip"
}

cmd_status() {
  local details id name ip status
  details="$(require_droplet)"
  IFS=$'\t' read -r id name ip status <<<"$details"
  printf 'Name: %s\nID: %s\nStatus: %s\nPublic IPv4: %s\n' "$name" "$id" "$status" "$ip"
  printf 'Plan: %s in %s (configured maximum: about $24/month; $0.036/hour)\n' "$SIZE" "$REGION"
  printf 'SSH: %s@%s using %s\n' "$TEST_USER" "$ip" "$SSH_PRIVATE_KEY"
}

cmd_ssh() {
  local details id name ip status
  details="$(require_droplet)"
  IFS=$'\t' read -r id name ip status <<<"$details"
  [[ "$status" == "active" ]] || die "Droplet is not active (status: $status)"
  [[ -n "$ip" ]] || die "Droplet has no public IPv4 address"
  if [[ $# -gt 0 ]]; then
    ssh "${SSH_OPTIONS[@]}" "$TEST_USER@$ip" "$@"
  else
    exec ssh "${SSH_OPTIONS[@]}" "$TEST_USER@$ip"
  fi
}

cmd_rebuild() {
  confirm_destructive rebuild "${1:-}"
  local details id name ip status
  details="$(require_droplet)"
  IFS=$'\t' read -r id name ip status <<<"$details"
  doctl compute droplet-action rebuild "$id" --image "$IMAGE" --wait >/dev/null
  remove_stale_host_key "$ip"
  prepare_test_user "$ip"
  replace_firewall "$id"
  printf 'Rebuilt Droplet %s (%s) from %s.\n' "$name" "$id" "$IMAGE"
}

cmd_refresh_firewall() {
  local details id name ip status
  details="$(require_droplet)"
  IFS=$'\t' read -r id name ip status <<<"$details"
  replace_firewall "$id"
}

cmd_destroy() {
  confirm_destructive destroy "${1:-}"
  local details id name ip status firewall
  details="$(require_droplet)"
  IFS=$'\t' read -r id name ip status <<<"$details"
  firewall="$(firewall_id)"
  if [[ -n "$firewall" ]]; then
    doctl compute firewall delete "$firewall" --force >/dev/null
  fi
  doctl compute droplet delete "$id" --force >/dev/null
  rm -f "$STATE_FILE"
  printf 'Destroyed Droplet %s (%s). Billing for it has stopped.\n' "$name" "$id"
}

main() {
  local command="${1:-}"
  if [[ -z "$command" || "$command" == "help" || "$command" == "--help" || "$command" == "-h" ]]; then
    usage
    return
  fi
  shift
  validate_config
  require_tools
  require_auth
  case "$command" in
    doctor) cmd_doctor "$@" ;;
    adopt) cmd_adopt "$@" ;;
    create) cmd_create "$@" ;;
    status) cmd_status "$@" ;;
    ssh) cmd_ssh "$@" ;;
    rebuild) cmd_rebuild "$@" ;;
    refresh-firewall) cmd_refresh_firewall "$@" ;;
    destroy) cmd_destroy "$@" ;;
    *) die "unknown command '$command'; run with --help" ;;
  esac
}

main "$@"
