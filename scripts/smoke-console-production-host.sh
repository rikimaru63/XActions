#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${XACTIONS_BASE_URL:-https://xactions.logence.co.jp}"
APP_UUID="${XACTIONS_COOLIFY_APP_UUID:-sg008w80csw08skkwcwswwgw}"
SMOKE_USERNAME="${XACTIONS_SMOKE_USERNAME:-test_account_20260521092255}"
API_CONTAINER="${XACTIONS_API_CONTAINER:-}"
WORKER_CONTAINER="${XACTIONS_WORKER_CONTAINER:-}"
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

case "$LIVE_READONLY_MODE" in
  auto|always|never) ;;
  *)
    echo "XACTIONS_PRODUCTION_LIVE_READONLY must be auto, always, or never." >&2
    exit 1
    ;;
esac

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

  const features = await requestJson('/api/console/features', token);
  assert(Array.isArray(features.categories), '/api/console/features did not return categories[].');
  assert(Array.isArray(features.features), '/api/console/features did not return features[].');
  assert(features.features.length >= 40, `/api/console/features returned too few features: ${features.features.length}`);

  const schedules = await requestJson('/api/scheduled-actions?limit=5', token);
  const scheduleItems = schedules.scheduledActions || schedules.schedules;
  assert(Array.isArray(scheduleItems), '/api/scheduled-actions did not return schedules[].');

  console.log(JSON.stringify({
    ok: true,
    authenticatedEndpoints: {
      accounts: accounts.accounts.length,
      categories: features.categories.length,
      features: features.features.length,
      scheduledActions: scheduleItems.length,
    },
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
NODE

docker exec "$API_CONTAINER" npm run verify:headless
echo "ok headless browser"

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

host_has_live_cookies() {
  [[ -n "${XACTIONS_LIVE_ACCOUNT_A_COOKIE:-}" && -n "${XACTIONS_LIVE_ACCOUNT_B_COOKIE:-}" ]]
}

container_has_live_cookies() {
  docker exec "$API_CONTAINER" sh -lc '[ -n "$XACTIONS_LIVE_ACCOUNT_A_COOKIE" ] && [ -n "$XACTIONS_LIVE_ACCOUNT_B_COOKIE" ]'
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
    -e XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true
  )
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
