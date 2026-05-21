# Console Production Smoke

Created: 2026-05-21

This smoke checks the production items from `docs/console-scheduler-multiaccount-spec.md`:

- `/api/health`
- `/console`
- `/api/accounts`
- `/api/console/features`
- `/api/scheduled-actions`
- hidden account/session secrets in authenticated account and schedule responses
- feature catalog audit, including console payload checks that keep account/session secrets out of jobs
- console locale audit that blocks mojibake in the main console and related account/schedule APIs
- scheduler smoke coverage for expired account visibility, execution rejection,
  schedule rejection, and no operation/schedule residue
- schedule management coverage for pause, update, resume, delete, and deleted lookup handling
- automatic due schedule coverage proving the worker picks persisted once
  schedules from the database without using run-now
- stale-lock recovery coverage proving old locked due schedules are picked up again
- account UI state coverage proving active and expired accounts render correctly and expired accounts are disabled
- headless Puppeteer / browserAutomation launch
- worker container running
- scheduler startup log
- live readonly E2E readiness, and live E2E itself when real accounts/cookies are available

Run it on the VPS host. The script is stored in the API image, then executed on
the host so it can inspect both API and worker containers.

```bash
api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker cp "$api":/app/scripts/smoke-console-production-host.sh /tmp/xactions-console-production-smoke.sh
bash /tmp/xactions-console-production-smoke.sh
```

Optional overrides:

```bash
XACTIONS_BASE_URL='https://xactions.logence.co.jp' \
XACTIONS_SMOKE_USERNAME='test_account_20260521092255' \
XACTIONS_COOLIFY_APP_UUID='sg008w80csw08skkwcwswwgw' \
bash scripts/smoke-console-production-host.sh
```

Live readonly mode:

- `XACTIONS_PRODUCTION_LIVE_READONLY=auto` is the default. It runs the live
  readonly smoke when either two active XAccounts exist for the smoke user or
  two live cookies are available. Otherwise it prints a skip reason and keeps
  the production smoke green.
- `XACTIONS_PRODUCTION_LIVE_READONLY=always` requires the live readonly smoke to
  run and fail loudly when accounts/cookies are missing.
- `XACTIONS_PRODUCTION_LIVE_READONLY=never` skips the live readonly check.

Examples:

```bash
XACTIONS_PRODUCTION_LIVE_READONLY='always' \
bash /tmp/xactions-console-production-smoke.sh
```

```bash
XACTIONS_PRODUCTION_LIVE_READONLY='always' \
XACTIONS_LIVE_ACCOUNT_A_COOKIE="$COOKIE_A" \
XACTIONS_LIVE_ACCOUNT_B_COOKIE="$COOKIE_B" \
bash /tmp/xactions-console-production-smoke.sh
```
