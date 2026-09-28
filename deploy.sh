#!/usr/bin/env bash
set -euo pipefail

IDENTITY_FILE="${IDENTITY_FILE:-$HOME/.ssh/pic_allier_id_rsa}"

step() {
    local desc="$1"; shift
    echo -e "\033[0;36m==> ${desc}\033[0m"
    if ! eval "$1"; then
        echo -e "\033[0;31m✘ Failed: ${desc}\033[0m" >&2
        exit 1
    fi
}

SERVER_USER="root"
SERVER_HOST="89.167.25.230"
SERVER_PATH="/opt/albus-crypto"
CHAIN_IMAGE="albus-chain:latest"
WEB_IMAGE="albus-web:latest"
ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "\033[0;31m✘ $ENV_FILE not found — copy .env.example to $ENV_FILE and fill in real values first.\033[0m" >&2
    exit 1
fi

VITE_ALBUS_API_URL="$(grep -E '^\s*VITE_ALBUS_API_URL\s*=' "$ENV_FILE" | tail -n1 | sed -E 's/^\s*VITE_ALBUS_API_URL\s*=\s*"?([^"]*)"?\s*$/\1/')"

if [[ -z "${VITE_ALBUS_API_URL:-}" ]]; then
    echo -e "\033[0;31m✘ VITE_ALBUS_API_URL missing or empty in $ENV_FILE\033[0m" >&2
    exit 1
fi

step "Pulling latest code" 'git pull'
step "Building chain image" 'docker build --pull -t "$CHAIN_IMAGE" ./chain'
step "Building web image" 'docker build --pull --build-arg VITE_ALBUS_API_URL="$VITE_ALBUS_API_URL" -t "$WEB_IMAGE" ./web'
step "Deploying to server" 'docker save "$CHAIN_IMAGE" "$WEB_IMAGE" | ssh "${SERVER_USER}@${SERVER_HOST}" "cd $SERVER_PATH && git pull && docker load && docker compose up -d --force-recreate && docker image prune -f"'

echo -e "\033[0;32m==> Done — https://albus.workflowsolved.com\033[0m"
