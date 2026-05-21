#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${XACTIONS_BASE_URL:-https://xactions.logence.co.jp}"
APP_UUID="${XACTIONS_COOLIFY_APP_UUID:-sg008w80csw08skkwcwswwgw}"
SMOKE_USERNAME="${XACTIONS_SMOKE_USERNAME:-test_account_20260521092255}"
API_CONTAINER="${XACTIONS_API_CONTAINER:-}"
WORKER_CONTAINER="${XACTIONS_WORKER_CONTAINER:-}"
SCHEDULER_SMOKE_MODE="${XACTIONS_PRODUCTION_SCHEDULER_SMOKE:-auto}"
WORKER_RESTART_SMOKE_MODE="${XACTIONS_PRODUCTION_WORKER_RESTART_SMOKE:-never}"
LIVE_READONLY_MODE="${XACTIONS_PRODUCTION_LIVE_READONLY:-auto}"

find_container() {
  local prefix="$1"
  docker ps --format '{{.Names}}' | grep "^${prefix}-${APP_UUID}" | head -n 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1" >&2
    exit 1
  fi
}

require_command docker
require_command curl

case "$SCHEDULER_SMOKE_MODE" in
  auto|always|never) ;;
  *)
    echo "XACTIONS_PRODUCTION_SCHEDULER_SMOKE must be auto, always, or never." >&2
    exit 1
    ;;
esac

case "$WORKER_RESTART_SMOKE_MODE" in
  always|never) ;;
  *)
    echo "XACTIONS_PRODUCTION_WORKER_RESTART_SMOKE must be always or never." >&2
    exit 1
    ;;
esac

case "$LIVE_READONLY_MODE" in
  auto|always|never) ;;
  *)
    echo "XACTIONS_PRODUCTION_LIVE_READONLY must be auto, always, or never." >&2
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
LIVE_ACCOUNT_ACCEPTANCE_ENV_VARS=(
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

if [[ -z "$API_CONTAINER" ]]; then
  API_CONTAINER="$(find_container api)"
fi
if [[ -z "$WORKER_CONTAINER" ]]; then
  WORKER_CONTAINER="$(find_container worker)"
fi

if [[ -z "$API_CONTAINER" ]]; then
  echo "api container not found for app uuid ${APP_UUID}" >&2
  exit 1
fi
if [[ -z "$WORKER_CONTAINER" ]]; then
  echo "worker container not found for app uuid ${APP_UUID}" >&2
  exit 1
fi

echo "baseUrl=${BASE_URL}"
echo "apiContainer=${API_CONTAINER}"
echo "workerContainer=${WORKER_CONTAINER}"
echo "schedulerSmokeMode=${SCHEDULER_SMOKE_MODE}"
echo "workerRestartSmokeMode=${WORKER_RESTART_SMOKE_MODE}"
echo "liveReadonlyMode=${LIVE_READONLY_MODE}"

health_body="$(curl -fsS "${BASE_URL}/api/health")"
echo "ok /api/health ${health_body}"

console_status="$(curl -fsS -o /tmp/xactions-console-smoke.html -w '%{http_code}' "${BASE_URL}/console")"
if [[ "$console_status" != "200" ]]; then
  echo "/console returned HTTP ${console_status}" >&2
  exit 1
fi
if ! grep -q '<html' /tmp/xactions-console-smoke.html; then
  echo "/console did not return HTML" >&2
  exit 1
fi
echo "ok /console"

dashboard_headers="$(curl -fsSI "${BASE_URL}/dashboard")"
if ! printf '%s\n' "$dashboard_headers" | grep -Eq '^HTTP/[0-9.]+ 30[1278]'; then
  echo "/dashboard did not redirect to /console" >&2
  printf '%s\n' "$dashboard_headers" >&2
  exit 1
fi
if ! printf '%s\n' "$dashboard_headers" | grep -Eiq '^location: /console'; then
  echo "/dashboard redirect target was not /console" >&2
  printf '%s\n' "$dashboard_headers" >&2
  exit 1
fi
echo "ok /dashboard -> /console"

classic_status="$(curl -fsS -o /tmp/xactions-classic-dashboard-smoke.html -w '%{http_code}' "${BASE_URL}/classic-dashboard")"
if [[ "$classic_status" != "200" ]]; then
  echo "/classic-dashboard returned HTTP ${classic_status}" >&2
  exit 1
fi
if ! grep -q '<html' /tmp/xactions-classic-dashboard-smoke.html; then
  echo "/classic-dashboard did not return HTML" >&2
  exit 1
fi
echo "ok /classic-dashboard"

docker exec -i \
  -e XACTIONS_BASE_URL="$BASE_URL" \
  -e XACTIONS_SMOKE_USERNAME="$SMOKE_USERNAME" \
  "$API_CONTAINER" node --input-type=module <<'NODE'
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const baseUrl = (process.env.XACTIONS_BASE_URL || '').replace(/\/$/, '');
const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME;
const prisma = new PrismaClient();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  assert(response.ok, `${path} returned HTTP ${response.status}: ${body?.error || text}`);
  return body;
}

function assertNoRawSensitiveFields(value, label, sensitiveKeys, path = label) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawSensitiveFields(item, label, sensitiveKeys, `${path}[${index}]`));
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (sensitiveKeys.has(key)) {
      const redacted = item == null || item === '' || item === '[hidden]' || item === '[redacted]';
      assert(redacted, `${label} leaked raw sensitive field: ${itemPath}`);
    }
    assertNoRawSensitiveFields(item, label, sensitiveKeys, itemPath);
  }
}

try {
  assert(process.env.JWT_SECRET, 'JWT_SECRET is required inside the API container.');
  const user = await prisma.user.findUnique({
    where: { username: smokeUsername },
    select: { id: true, username: true },
  });
  assert(user, `Smoke user not found: ${smokeUsername}`);
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const accounts = await requestJson('/api/accounts', token);
  assert(Array.isArray(accounts.accounts), '/api/accounts did not return accounts[].');
  assertNoRawSensitiveFields(accounts, '/api/accounts', new Set([
    'encryptedCookie',
    'sessionCookie',
    'cookie',
    'cookies',
    'authToken',
    'accessToken',
    'refreshToken',
    'password',
    'secret',
  ]));

  const features = await requestJson('/api/console/features', token);
  assert(Array.isArray(features.categories), '/api/console/features did not return categories[].');
  assert(Array.isArray(features.features), '/api/console/features did not return features[].');
  assert(features.features.length >= 40, `/api/console/features returned too few features: ${features.features.length}`);

  const schedules = await requestJson('/api/scheduled-actions?limit=5', token);
  const scheduleItems = schedules.scheduledActions || schedules.schedules;
  assert(Array.isArray(scheduleItems), '/api/scheduled-actions did not return schedules[].');
  assertNoRawSensitiveFields(schedules, '/api/scheduled-actions', new Set([
    'encryptedCookie',
    'sessionCookie',
    'cookie',
    'cookies',
    'authToken',
    'accessToken',
    'refreshToken',
    'password',
    'secret',
  ]));

  console.log(JSON.stringify({
    ok: true,
    authenticatedEndpoints: {
      accounts: accounts.accounts.length,
      categories: features.categories.length,
      features: features.features.length,
      scheduledActions: scheduleItems.length,
    },
    sensitiveFieldsHidden: true,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
NODE

docker exec "$API_CONTAINER" npm run audit:console-catalog
echo "ok console catalog audit"

acceptance_args=(-e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}")
if [[ "$LIVE_READONLY_MODE" == "always" ]]; then
  acceptance_args+=(-e XACTIONS_ACCEPTANCE_REQUIRE_LIVE=true)
fi
append_host_env_if_present acceptance_args "${LIVE_ACCOUNT_ACCEPTANCE_ENV_VARS[@]}"

docker exec "${acceptance_args[@]}" "$API_CONTAINER" npm run audit:console-acceptance
echo "ok console acceptance audit"

docker exec \
  -e XACTIONS_BASE_URL="$BASE_URL" \
  "$API_CONTAINER" npm run smoke:console-legacy-session
echo "ok legacy session migration smoke"

docker exec "$API_CONTAINER" npm run verify:headless
echo "ok headless browser"

docker exec \
  -e XACTIONS_BASE_URL="$BASE_URL" \
  -e XACTIONS_SMOKE_USERNAME="$SMOKE_USERNAME" \
  "$API_CONTAINER" npm run smoke:console-ui
echo "ok console UI"

docker exec \
  -e XACTIONS_BASE_URL="$BASE_URL" \
  -e XACTIONS_SMOKE_USERNAME="$SMOKE_USERNAME" \
  "$API_CONTAINER" npm run smoke:console-ui-accounts
echo "ok console account UI"

worker_status="$(docker inspect -f '{{.State.Status}}' "$WORKER_CONTAINER")"
if [[ "$worker_status" != "running" ]]; then
  echo "worker container is not running: ${worker_status}" >&2
  exit 1
fi
echo "ok worker running"

worker_logs="$(docker logs --tail 200 "$WORKER_CONTAINER" 2>&1)"
if ! grep -q 'Scheduled action scheduler started' <<<"$worker_logs"; then
  echo "scheduler start log was not found in worker logs" >&2
  exit 1
fi
echo "ok scheduler log"

maybe_run_scheduler_smoke() {
  if [[ "$SCHEDULER_SMOKE_MODE" == "never" ]]; then
    echo "skip scheduler smoke: disabled by XACTIONS_PRODUCTION_SCHEDULER_SMOKE=never"
    return 0
  fi

  docker exec \
    -e XACTIONS_BASE_URL="$BASE_URL" \
    -e XACTIONS_SMOKE_USERNAME="$SMOKE_USERNAME" \
    "$API_CONTAINER" npm run smoke:console-scheduler
  echo "ok console scheduler smoke"
}

maybe_run_scheduler_smoke

maybe_run_worker_restart_smoke() {
  if [[ "$WORKER_RESTART_SMOKE_MODE" == "never" ]]; then
    echo "skip worker restart smoke: disabled by XACTIONS_PRODUCTION_WORKER_RESTART_SMOKE=never"
    return 0
  fi

  docker cp "$API_CONTAINER":/app/scripts/smoke-console-worker-restart-host.sh /tmp/xactions-worker-restart-smoke.sh
  XACTIONS_COOLIFY_APP_UUID="$APP_UUID" \
    XACTIONS_SMOKE_USERNAME="$SMOKE_USERNAME" \
    XACTIONS_API_CONTAINER="$API_CONTAINER" \
    XACTIONS_WORKER_CONTAINER="$WORKER_CONTAINER" \
    bash /tmp/xactions-worker-restart-smoke.sh
  echo "ok worker restart smoke"
}

maybe_run_worker_restart_smoke

host_has_live_cookies() {
  [[ -n "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" && -n "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]]
}

container_has_live_cookies() {
  docker exec "$API_CONTAINER" sh -lc '[ -n "$XACTIONS_LIVE_ACCOUNT_A_COOKIE" ] && [ -n "$XACTIONS_LIVE_ACCOUNT_B_COOKIE" ]'
}

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

active_xaccount_count() {
  docker exec -i \
    -e XACTIONS_SMOKE_USERNAME="$SMOKE_USERNAME" \
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

run_live_readonly_with_cookies() {
  local args=(
    -e "XACTIONS_BASE_URL=${BASE_URL}"
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}"
  )
  if [[ -n "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" ]]; then
    args+=(-e "XACTIONS_LIVE_ACCOUNT_A_COOKIE=${XACTIONS_LIVE_ACCOUNT_A_COOKIE}")
  fi
  if [[ -n "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]]; then
    args+=(-e "XACTIONS_LIVE_ACCOUNT_B_COOKIE=${XACTIONS_LIVE_ACCOUNT_B_COOKIE}")
  fi
  if [[ -n "${XACTIONS_LIVE_PROFILE_TARGET:-}" ]]; then
    args+=(-e "XACTIONS_LIVE_PROFILE_TARGET=${XACTIONS_LIVE_PROFILE_TARGET}")
  fi

  docker exec "${args[@]}" "$API_CONTAINER" npm run smoke:console-live-readonly
}

run_live_readonly_with_existing_accounts() {
  local args=(
    -e "XACTIONS_BASE_URL=${BASE_URL}"
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}"
  )
  append_host_env_if_present args "${LIVE_ACCOUNT_SELECTOR_ENV_VARS[@]}"
  if env_true "${XACTIONS_LIVE_USE_EXISTING_ACCOUNTS:-}"; then
    args+=(-e "XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=${XACTIONS_LIVE_USE_EXISTING_ACCOUNTS}")
  fi
  if ! host_has_existing_account_selector && ! container_has_existing_account_selector; then
    args+=(-e XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true)
  fi
  if [[ -n "${XACTIONS_LIVE_PROFILE_TARGET:-}" ]]; then
    args+=(-e "XACTIONS_LIVE_PROFILE_TARGET=${XACTIONS_LIVE_PROFILE_TARGET}")
  fi

  docker exec "${args[@]}" "$API_CONTAINER" npm run smoke:console-live-readonly
}

maybe_run_live_readonly() {
  if [[ "$LIVE_READONLY_MODE" == "never" ]]; then
    echo "skip live readonly smoke: disabled by XACTIONS_PRODUCTION_LIVE_READONLY=never"
    return 0
  fi

  local active_count
  active_count="$(active_xaccount_count)"

  if host_has_live_cookies; then
    echo "run live readonly smoke: host cookies"
    run_live_readonly_with_cookies
    return 0
  fi

  if host_has_existing_account_selector || container_has_existing_account_selector; then
    echo "run live readonly smoke: selected existing XAccounts"
    run_live_readonly_with_existing_accounts
    return 0
  fi

  if [[ "$active_count" -ge 2 ]]; then
    echo "run live readonly smoke: existing active XAccounts (${active_count})"
    run_live_readonly_with_existing_accounts
    return 0
  fi

  if container_has_live_cookies; then
    echo "run live readonly smoke: container cookies"
    run_live_readonly_with_cookies
    return 0
  fi

  if [[ "$LIVE_READONLY_MODE" == "always" ]]; then
    echo "live readonly smoke required but unavailable: activeXAccounts=${active_count}, live cookies missing" >&2
    return 1
  fi

  echo "skip live readonly smoke: activeXAccounts=${active_count}, live cookies missing"
}

maybe_run_live_readonly

echo "ok console production smoke"
