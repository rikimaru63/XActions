#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${XACTIONS_BASE_URL:-https://xactions.logence.co.jp}"
APP_UUID="${XACTIONS_COOLIFY_APP_UUID:-sg008w80csw08skkwcwswwgw}"
SMOKE_USERNAME="${XACTIONS_SMOKE_USERNAME:-test_account_20260521092255}"
PROFILE_TARGET="${XACTIONS_LIVE_PROFILE_TARGET:-x}"
API_CONTAINER="${XACTIONS_API_CONTAINER:-}"
SOURCE="${XACTIONS_LIVE_READONLY_SOURCE:-auto}"

find_api_container() {
  docker ps --format '{{.Names}}' | grep "^api-${APP_UUID}" | head -n 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1" >&2
    exit 1
  fi
}

require_command docker

case "$SOURCE" in
  auto|prompt|env|existing|diagnose) ;;
  *)
    echo "XACTIONS_LIVE_READONLY_SOURCE must be auto, prompt, env, existing, or diagnose." >&2
    exit 1
    ;;
esac

LIVE_ACCOUNT_SELECTOR_ENV_VARS=(
  XACTIONS_LIVE_ACCOUNT_IDS
  XACTIONS_LIVE_ACCOUNT_A_ID
  XACTIONS_LIVE_ACCOUNT_B_ID
  XACTIONS_LIVE_ACCOUNT_USERNAMES
  XACTIONS_LIVE_ACCOUNT_A_USERNAME
  XACTIONS_LIVE_ACCOUNT_B_USERNAME
)
LIVE_ACCOUNT_READINESS_ENV_VARS=(
  XACTIONS_LIVE_ACCOUNT_A_COOKIE
  XACTIONS_LIVE_ACCOUNT_B_COOKIE
  "${LIVE_ACCOUNT_SELECTOR_ENV_VARS[@]}"
  XACTIONS_LIVE_USE_EXISTING_ACCOUNTS
)

env_true() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

append_host_env_if_present() {
  local target_array_name="$1"
  shift
  local -n target_array="$target_array_name"
  local var_name
  for var_name in "$@"; do
    if [[ -n "${!var_name:-}" ]]; then
      target_array+=(-e "${var_name}=${!var_name}")
    fi
  done
}

host_has_existing_account_selector() {
  local var_name
  for var_name in "${LIVE_ACCOUNT_SELECTOR_ENV_VARS[@]}"; do
    if [[ -n "${!var_name:-}" ]]; then
      return 0
    fi
  done
  env_true "${XACTIONS_LIVE_USE_EXISTING_ACCOUNTS:-}"
}

host_has_live_cookies() {
  [[ -n "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" && -n "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]]
}

if [[ -z "$API_CONTAINER" ]]; then
  API_CONTAINER="$(find_api_container)"
fi
if [[ -z "$API_CONTAINER" ]]; then
  echo "api container not found for app uuid ${APP_UUID}" >&2
  exit 1
fi

echo "baseUrl=${BASE_URL}"
echo "apiContainer=${API_CONTAINER}"
echo "smokeUsername=${SMOKE_USERNAME}"
echo "profileTarget=${PROFILE_TARGET}"
echo "source=${SOURCE}"

container_has_existing_account_selector() {
  docker exec "$API_CONTAINER" sh -lc '
case "$(printf "%s" "${XACTIONS_LIVE_USE_EXISTING_ACCOUNTS:-}" | tr "[:upper:]" "[:lower:]")" in
  1|true|yes|on) exit 0 ;;
esac
[ -n "${XACTIONS_LIVE_ACCOUNT_IDS:-}" ] \
  || [ -n "${XACTIONS_LIVE_ACCOUNT_A_ID:-}" ] \
  || [ -n "${XACTIONS_LIVE_ACCOUNT_B_ID:-}" ] \
  || [ -n "${XACTIONS_LIVE_ACCOUNT_USERNAMES:-}" ] \
  || [ -n "${XACTIONS_LIVE_ACCOUNT_A_USERNAME:-}" ] \
  || [ -n "${XACTIONS_LIVE_ACCOUNT_B_USERNAME:-}" ]
'
}

container_has_live_cookies() {
  docker exec "$API_CONTAINER" sh -lc '[ -n "$XACTIONS_LIVE_ACCOUNT_A_COOKIE" ] && [ -n "$XACTIONS_LIVE_ACCOUNT_B_COOKIE" ]'
}

active_xaccount_count() {
  docker exec -i \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    "$API_CONTAINER" node --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({
    where: { username: process.env.XACTIONS_SMOKE_USERNAME },
    select: { id: true },
  });
  const count = user
    ? await prisma.xAccount.count({ where: { userId: user.id, status: 'active' } })
    : 0;
  console.log(String(count));
} finally {
  await prisma.$disconnect();
}
NODE
}

diagnose_readiness() {
  echo "hostLiveCookieA=$([[ -n "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" ]] && echo present || echo missing)"
  echo "hostLiveCookieB=$([[ -n "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]] && echo present || echo missing)"

  local args=(
    -e "XACTIONS_BASE_URL=${BASE_URL}"
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}"
    -e "XACTIONS_LIVE_PROFILE_TARGET=${PROFILE_TARGET}"
  )
  append_host_env_if_present args "${LIVE_ACCOUNT_READINESS_ENV_VARS[@]}"

  docker exec "${args[@]}" \
    -e XACTIONS_LIVE_READONLY_DIAGNOSE=true \
    "$API_CONTAINER" npm run smoke:console-live-readonly
}

run_with_existing_accounts() {
  local args=(
    -e "XACTIONS_BASE_URL=${BASE_URL}"
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}"
    -e "XACTIONS_LIVE_PROFILE_TARGET=${PROFILE_TARGET}"
  )
  append_host_env_if_present args "${LIVE_ACCOUNT_SELECTOR_ENV_VARS[@]}"
  if env_true "${XACTIONS_LIVE_USE_EXISTING_ACCOUNTS:-}"; then
    args+=(-e "XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=${XACTIONS_LIVE_USE_EXISTING_ACCOUNTS}")
  fi
  if ! host_has_existing_account_selector && ! container_has_existing_account_selector; then
    args+=(-e XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true)
  fi

  docker exec "${args[@]}" "$API_CONTAINER" npm run smoke:console-live-readonly
}

run_with_cookie_stdin() {
  local cookie_a="$1"
  local cookie_b="$2"

  printf '%s\n%s\n' "$cookie_a" "$cookie_b" | docker exec -i \
    -e "XACTIONS_BASE_URL=${BASE_URL}" \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    -e "XACTIONS_LIVE_PROFILE_TARGET=${PROFILE_TARGET}" \
    "$API_CONTAINER" sh -lc '
      IFS= read -r COOKIE_A
      IFS= read -r COOKIE_B
      export XACTIONS_LIVE_ACCOUNT_A_COOKIE="$COOKIE_A"
      export XACTIONS_LIVE_ACCOUNT_B_COOKIE="$COOKIE_B"
      npm run smoke:console-live-readonly
    '
}

run_with_container_cookies() {
  docker exec \
    -e "XACTIONS_BASE_URL=${BASE_URL}" \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    -e "XACTIONS_LIVE_PROFILE_TARGET=${PROFILE_TARGET}" \
    "$API_CONTAINER" npm run smoke:console-live-readonly
}

prompt_and_run_with_cookie_stdin() {
  if [[ ! -t 0 ]]; then
    echo "live readonly smoke is not ready for non-interactive execution." >&2
    echo "Set XACTIONS_LIVE_ACCOUNT_A_COOKIE and XACTIONS_LIVE_ACCOUNT_B_COOKIE, select two existing XAccounts, or run with SOURCE=diagnose." >&2
    exit 1
  fi

  read -rsp 'X Cookie A: ' COOKIE_A
  echo
  read -rsp 'X Cookie B: ' COOKIE_B
  echo
  if [[ -z "$COOKIE_A" || -z "$COOKIE_B" ]]; then
    unset COOKIE_A COOKIE_B
    echo "Both cookies are required." >&2
    exit 1
  fi
  run_with_cookie_stdin "$COOKIE_A" "$COOKIE_B"
  unset COOKIE_A COOKIE_B
}

case "$SOURCE" in
  auto)
    if host_has_live_cookies; then
      echo "run live readonly smoke: host cookies"
      run_with_cookie_stdin "$XACTIONS_LIVE_ACCOUNT_A_COOKIE" "$XACTIONS_LIVE_ACCOUNT_B_COOKIE"
      exit 0
    fi

    if host_has_existing_account_selector || container_has_existing_account_selector; then
      echo "run live readonly smoke: selected existing XAccounts"
      run_with_existing_accounts
      exit 0
    fi

    active_count="$(active_xaccount_count)"
    if [[ "$active_count" -ge 2 ]]; then
      echo "run live readonly smoke: existing active XAccounts (${active_count})"
      run_with_existing_accounts
      exit 0
    fi

    if container_has_live_cookies; then
      echo "run live readonly smoke: container cookies"
      run_with_container_cookies
      exit 0
    fi

    echo "live readonly smoke is not ready: activeXAccounts=${active_count}, live cookies missing"
    if [[ -t 0 ]]; then
      echo "Falling back to secure cookie prompt. Press Ctrl+C to stop."
    fi
    prompt_and_run_with_cookie_stdin
    ;;
  diagnose)
    diagnose_readiness
    ;;
  existing)
    run_with_existing_accounts
    ;;
  env)
    if [[ -z "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" || -z "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]]; then
      echo "XACTIONS_LIVE_ACCOUNT_A_COOKIE and XACTIONS_LIVE_ACCOUNT_B_COOKIE are required when SOURCE=env." >&2
      exit 1
    fi
    run_with_cookie_stdin "$XACTIONS_LIVE_ACCOUNT_A_COOKIE" "$XACTIONS_LIVE_ACCOUNT_B_COOKIE"
    ;;
  prompt)
    prompt_and_run_with_cookie_stdin
    ;;
esac
