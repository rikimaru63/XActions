# Console Production Smoke

Created: 2026-05-21

This smoke checks the production items from `docs/console-scheduler-multiaccount-spec.md`:

- `/api/health`
- `/console`
- `/api/accounts`
- `/api/console/features`
- `/api/scheduled-actions`
- worker container running
- scheduler startup log

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
