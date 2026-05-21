#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${XACTIONS_BASE_URL:-https://xactions.logence.co.jp}"
APP_UUID="${XACTIONS_COOLIFY_APP_UUID:-sg008w80csw08skkwcwswwgw}"
SMOKE_USERNAME="${XACTIONS_SMOKE_USERNAME:-test_account_20260521092255}"
PROFILE_TARGET="${XACTIONS_LIVE_PROFILE_TARGET:-x}"
API_CONTAINER="${XACTIONS_API_CONTAINER:-}"
SOURCE="${XACTIONS_LIVE_READONLY_SOURCE:-prompt}"

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
  prompt|env|existing|diagnose) ;;
  *)
    echo "XACTIONS_LIVE_READONLY_SOURCE must be prompt, env, existing, or diagnose." >&2
    exit 1
    ;;
esac

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

diagnose_readiness() {
  echo "hostLiveCookieA=$([[ -n "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" ]] && echo present || echo missing)"
  echo "hostLiveCookieB=$([[ -n "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]] && echo present || echo missing)"

  docker exec -i \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    "$API_CONTAINER" node --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({
    where: { username: process.env.XACTIONS_SMOKE_USERNAME },
    select: { id: true, username: true },
  });
  const activeAccounts = user
    ? await prisma.xAccount.findMany({
        where: { userId: user.id, status: 'active' },
        select: { id: true, status: true, lastVerifiedAt: true },
      })
    : [];

  console.log(JSON.stringify({
    ok: true,
    smokeUserFound: Boolean(user),
    activeXAccounts: activeAccounts.length,
    verifiedActiveXAccounts: activeAccounts.filter((account) => account.lastVerifiedAt).length,
    containerLiveCookieA: Boolean(process.env.XACTIONS_LIVE_ACCOUNT_A_COOKIE),
    containerLiveCookieB: Boolean(process.env.XACTIONS_LIVE_ACCOUNT_B_COOKIE),
    readyWithExistingAccounts: activeAccounts.length >= 2,
    readyWithContainerCookies: Boolean(process.env.XACTIONS_LIVE_ACCOUNT_A_COOKIE && process.env.XACTIONS_LIVE_ACCOUNT_B_COOKIE),
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
NODE
}

run_with_existing_accounts() {
  docker exec \
    -e "XACTIONS_BASE_URL=${BASE_URL}" \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    -e "XACTIONS_LIVE_PROFILE_TARGET=${PROFILE_TARGET}" \
    -e XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true \
    "$API_CONTAINER" npm run smoke:console-live-readonly
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

case "$SOURCE" in
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
    ;;
esac
