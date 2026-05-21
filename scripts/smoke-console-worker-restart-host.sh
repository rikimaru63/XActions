#!/usr/bin/env bash
set -euo pipefail

APP_UUID="${XACTIONS_COOLIFY_APP_UUID:-sg008w80csw08skkwcwswwgw}"
SMOKE_USERNAME="${XACTIONS_SMOKE_USERNAME:-test_account_20260521092255}"
API_CONTAINER="${XACTIONS_API_CONTAINER:-}"
WORKER_CONTAINER="${XACTIONS_WORKER_CONTAINER:-}"
SMOKE_ID=""

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

worker_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || echo false)" == "true" ]]
}

cleanup() {
  local status=$?
  if [[ -n "$WORKER_CONTAINER" ]] && ! worker_running; then
    docker start "$WORKER_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SMOKE_ID" && -n "$API_CONTAINER" ]]; then
    docker exec \
      -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
      -e "XACTIONS_WORKER_RESTART_SMOKE_ID=${SMOKE_ID}" \
      "$API_CONTAINER" npm run -s smoke:console-worker-restart -- cleanup || true
  fi
  exit "$status"
}

require_command docker

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

echo "apiContainer=${API_CONTAINER}"
echo "workerContainer=${WORKER_CONTAINER}"
echo "smokeUsername=${SMOKE_USERNAME}"

trap cleanup EXIT

echo "stop worker"
docker stop -t 30 "$WORKER_CONTAINER" >/dev/null

prepare_output="$(
  docker exec \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    "$API_CONTAINER" npm run -s smoke:console-worker-restart -- prepare
)"
echo "$prepare_output"
SMOKE_ID="$(printf '%s\n' "$prepare_output" | sed -n 's/.*"smokeId":"\([^"]*\)".*/\1/p' | tail -n 1)"
if [[ -z "$SMOKE_ID" ]]; then
  echo "could not parse smokeId from prepare output" >&2
  exit 1
fi

echo "start worker"
docker start "$WORKER_CONTAINER" >/dev/null

verify_output="$(
  docker exec \
    -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
    -e "XACTIONS_WORKER_RESTART_SMOKE_ID=${SMOKE_ID}" \
    "$API_CONTAINER" npm run -s smoke:console-worker-restart -- verify
)"
echo "$verify_output"

docker exec \
  -e "XACTIONS_SMOKE_USERNAME=${SMOKE_USERNAME}" \
  -e "XACTIONS_WORKER_RESTART_SMOKE_ID=${SMOKE_ID}" \
  "$API_CONTAINER" npm run -s smoke:console-worker-restart -- cleanup
SMOKE_ID=""
trap - EXIT

echo "ok worker restart smoke"
