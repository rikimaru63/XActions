#!/usr/bin/env bash
set -euo pipefail

APP_UUID="${XACTIONS_COOLIFY_APP_UUID:-sg008w80csw08skkwcwswwgw}"
SMOKE_USERNAME="${XACTIONS_SMOKE_USERNAME:-test_account_20260521092255}"
API_CONTAINER="${XACTIONS_API_CONTAINER:-}"

cleanup() {
  unset XACTIONS_LIVE_ACCOUNT_A_COOKIE XACTIONS_LIVE_ACCOUNT_B_COOKIE
}

find_api_container() {
  docker ps --format '{{.Names}}' | grep "^api-${APP_UUID}" | head -n 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1" >&2
    exit 1
  fi
}

read_visible() {
  local prompt="$1"
  local var_name="$2"
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then
    printf -v "$var_name" '%s' "$current"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    echo "${var_name} is required in non-interactive mode." >&2
    exit 1
  fi
  read -rp "$prompt" "$var_name"
}

read_secret() {
  local prompt="$1"
  local var_name="$2"
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then
    printf -v "$var_name" '%s' "$current"
    return 0
  fi
  if [[ -t 0 ]]; then
    read -rsp "$prompt" "$var_name"
    echo
    return 0
  fi
  IFS= read -r "$var_name" || true
}

require_command docker
trap cleanup EXIT

if [[ -z "$API_CONTAINER" ]]; then
  API_CONTAINER="$(find_api_container)"
fi
if [[ -z "$API_CONTAINER" ]]; then
  echo "api container not found for app uuid ${APP_UUID}" >&2
  exit 1
fi

read_visible 'X username A: ' XACTIONS_LIVE_ACCOUNT_A_USERNAME
read_visible 'X username B: ' XACTIONS_LIVE_ACCOUNT_B_USERNAME
read_secret 'X Cookie A: ' XACTIONS_LIVE_ACCOUNT_A_COOKIE
read_secret 'X Cookie B: ' XACTIONS_LIVE_ACCOUNT_B_COOKIE

if [[ -z "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" || -z "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]]; then
  echo "Both cookies are required." >&2
  exit 1
fi

printf '%s\n%s\n' "$XACTIONS_LIVE_ACCOUNT_A_COOKIE" "$XACTIONS_LIVE_ACCOUNT_B_COOKIE" | docker exec -i \
  -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
  -e "XACTIONS_LIVE_ACCOUNT_A_USERNAME=${XACTIONS_LIVE_ACCOUNT_A_USERNAME}" \
  -e "XACTIONS_LIVE_ACCOUNT_B_USERNAME=${XACTIONS_LIVE_ACCOUNT_B_USERNAME}" \
  "$API_CONTAINER" npm run register:console-live-accounts

echo "ok registered live XAccounts for ${SMOKE_USERNAME}"
echo "Next:"
echo "  api=\"\$(docker ps --format '{{.Names}}' | grep '^api-${APP_UUID}' | head -n 1)\""
echo "  docker cp \"\$api\":/app/scripts/run-console-live-readonly-host.sh /tmp/xactions-live-readonly.sh"
echo "  XACTIONS_LIVE_READONLY_SOURCE=existing bash /tmp/xactions-live-readonly.sh"
