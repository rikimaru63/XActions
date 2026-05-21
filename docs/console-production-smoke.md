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
- failed-account retry coverage proving only failed child operations are re-queued
  and retry inputs stay encrypted
- optional worker restart recovery smoke proving an unexecuted DB schedule is
  picked up after the worker container starts again
- console UI navigation coverage proving all categories, settings, schedules, history, and live confirmation modal render
- account UI state coverage proving multiple active accounts can be selected,
  history/schedule requests are filtered by selected accounts, and expired
  accounts are disabled
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

Scheduler smoke mode:

- `XACTIONS_PRODUCTION_SCHEDULER_SMOKE=auto` is the default. It runs the
  production-safe scheduler smoke, including multiple temporary accounts,
  due schedules, stale-lock recovery, interval recurrence, run history, and
  cleanup residue checks.
- `XACTIONS_PRODUCTION_SCHEDULER_SMOKE=always` currently behaves like `auto`
  and is available for explicit CI configuration.
- `XACTIONS_PRODUCTION_SCHEDULER_SMOKE=never` skips the scheduler smoke when
  you only want the lighter endpoint/UI checks.

Worker restart smoke:

This intentionally stops only the XActions worker container, creates a due
dry-run schedule while the worker is stopped, starts the same worker container,
and verifies the schedule is completed from the database.

It is disabled in the default production smoke because it briefly stops the
worker. Enable it explicitly when validating restart recovery:

```bash
XACTIONS_PRODUCTION_WORKER_RESTART_SMOKE=always \
bash /tmp/xactions-console-production-smoke.sh
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
