#!/usr/bin/env bash
# Private local deployment helper. Builds source locally, binds only to loopback,
# and publishes the app through Tailscale Serve (never Tailscale Funnel).
set -euo pipefail
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_FILE="$PROJECT_DIR/.env.example"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILES=(-f "$PROJECT_DIR/docker-compose.yml" -f "$PROJECT_DIR/docker-compose.dev.yml")

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "$1 is required."; }

mask_value() {
    local value="$1" length
    length=${#value}
    if (( length == 0 )); then printf '(empty)'; return; fi
    if (( length == 1 )); then printf '*'; return; fi
    if (( length <= 8 )); then printf '%s…%s' "${value:0:1}" "${value: -1}"; return; fi
    printf '%s…%s' "${value:0:4}" "${value: -4}"
}

declare -A values template_keys
declare -a ordered_keys

read_dotenv() {
    local file="$1" line key value
    [[ -f "$file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            values["$key"]="$value"
        fi
    done < "$file"
}

is_generated_secret() {
    [[ "$1" == 'SESSION_SECRET' || "$1" == 'PAYMENT_IMPORT_WEBHOOK_SECRET' ]]
}

prompt_value() {
    local key="$1" current answer
    current="${values[$key]-}"
    printf '%s [current: %s; Enter keeps it' "$key" "$(mask_value "$current")"
    if [[ -z "$current" ]] && is_generated_secret "$key"; then
        printf '; type generate for a new secret'
    fi
    printf ']: '
    IFS= read -r -s answer || die 'input cancelled'
    printf '\n'
    if [[ -z "$answer" ]]; then return; fi
    if [[ "$answer" == 'generate' ]] && is_generated_secret "$key"; then
        require_command openssl
        values["$key"]="$(openssl rand -hex 32)"
        printf '%s generated and stored locally.\n' "$key"
    else
        values["$key"]="$answer"
    fi
}

write_dotenv() {
    local temporary line key
    temporary="$(mktemp "$PROJECT_DIR/.env.tmp.XXXXXX")"
    trap 'rm -f "$temporary"' EXIT
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            printf '%s=%s\n' "$key" "${values[$key]-}"
        else
            printf '%s\n' "$line"
        fi
    done < "$TEMPLATE_FILE" > "$temporary"

    # Retain local fields that a future template has not yet learned about.
    for key in "${!values[@]}"; do
        [[ -n "${template_keys[$key]-}" ]] && continue
        printf '%s=%s\n' "$key" "${values[$key]}" >> "$temporary"
    done
    chmod 600 "$temporary"
    mv "$temporary" "$ENV_FILE"
    trap - EXIT
}

validate_dotenv() {
    local webhook_secret="${values[PAYMENT_IMPORT_WEBHOOK_SECRET]-}"
    local webhook_senders="${values[PAYMENT_IMPORT_ALLOWED_SENDERS]-}"
    local tuya_id="${values[TUYA_CLIENT_ID]-}"
    local tuya_secret="${values[TUYA_CLIENT_SECRET]-}"
    local tuya_device="${values[TUYA_DEVICE_ID]-}"
    [[ -n "${values[SESSION_SECRET]-}" ]] || die 'SESSION_SECRET cannot be empty.'
    [[ "${values[PORT]-8080}" =~ ^[0-9]+$ ]] || die 'PORT must be numeric.'
    if [[ -n "$webhook_secret" || -n "$webhook_senders" ]]; then
        [[ ${#webhook_secret} -ge 32 && -n "$webhook_senders" ]] || die 'Payment imports require both a 32+ character secret and allowed senders, or neither to remain disabled.'
    fi
    if [[ -n "$tuya_id" || -n "$tuya_secret" || -n "$tuya_device" ]]; then
        [[ -n "$tuya_id" && -n "$tuya_secret" && -n "$tuya_device" ]] || die 'Tuya sync requires client ID, client secret, and device ID, or none to remain disabled.'
        [[ "${values[TUYA_REGION]-eu}" =~ ^(eu|us|cn)$ ]] || die 'TUYA_REGION must be eu, us, or cn.'
    fi
}

harden_data_directory() {
    local data_dir="$PROJECT_DIR/data"
    mkdir -p "$data_dir"
    # SQLite may create WAL/SHM files at runtime. The private directory prevents
    # other local users reaching them; existing files are tightened as well.
    chmod 700 "$data_dir"
    find "$data_dir" -type f -exec chmod 600 {} +
}

wait_for_health() {
    local attempt health
    for attempt in $(seq 1 40); do
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' poultry-dss 2>/dev/null || true)"
        [[ "$health" == 'healthy' ]] && return
        sleep 3
    done
    die 'PoultryProject did not become healthy; inspect with: docker logs poultry-dss'
}

main() {
    local line key
    require_command docker
    require_command tailscale
    require_command curl
    require_command ss
    [[ -f "$TEMPLATE_FILE" ]] || die "missing $TEMPLATE_FILE"
    docker compose version >/dev/null || die 'Docker Compose v2 is required.'
    tailscale status >/dev/null || die 'Tailscale must be connected first.'

    read_dotenv "$TEMPLATE_FILE"
    read_dotenv "$ENV_FILE"
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
            key="${BASH_REMATCH[1]}"
            template_keys["$key"]=1
            ordered_keys+=("$key")
        fi
    done < "$TEMPLATE_FILE"

    printf 'Update local dotenv values. Existing values are masked; Enter retains them.\n'
    for key in "${ordered_keys[@]}"; do prompt_value "$key"; done
    validate_dotenv
    write_dotenv
    harden_data_directory

    if ss -ltn '( sport = :8089 )' | grep -q LISTEN && ! docker inspect poultry-dss >/dev/null 2>&1; then
        die 'port 8089 is already in use by something other than PoultryProject.'
    fi

    PUID="$(id -u)" PGID="$(id -g)" IMAGE_REF='poultry-dss:local' \
        docker compose "${COMPOSE_FILES[@]}" up --build -d --force-recreate poultry-dss
    wait_for_health
    curl --fail --silent --show-error http://127.0.0.1:8089/api/healthz >/dev/null
    tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:8089

    printf '\nDeployment healthy. Private access:\n'
    tailscale serve status
}

main "$@"
