import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { features, getFeatureById, getPublicFeatureCatalog } from '../api/config/features.js';
import {
  cooldownKey,
  shouldSerializeAccountJob,
  shouldThrottleAccountJob,
  withAccountExecutionLock,
} from '../api/services/accountExecutionLock.js';
import {
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
  explicitAccountIdsFromQuery,
  MAX_ACCOUNT_SELECTION,
  operationAccountHistoryWhere,
} from '../api/services/accountSelection.js';
import {
  accountPauseMessage,
  buildAccountLiveReadiness,
  isSessionExpiredError,
  shouldPauseSchedulesForAccountStatus,
} from '../api/services/accountStore.js';
import {
  createActionPayload,
  operationMatchesFeatureHistory,
  sanitizeConfig,
  sanitizeOperation,
} from '../api/services/consoleActions.js';
import {
  buildEncryptedRetryConfig,
  decryptRetryConfig,
  recoverRetryConfig,
} from '../api/services/consoleRetryConfig.js';
import { summarizeChildStatuses } from '../api/services/operationBatches.js';
import { restoreQueueJobConfig, sanitizeQueueJobData } from '../api/services/queuePayload.js';
import {
  getJobRetryState,
  normalizeScheduleMaxRetries,
  queueAttemptsForSchedule,
} from '../api/services/retryPolicy.js';
import {
  assertScheduleAccountRunnable,
  publicScheduledActionRun,
} from '../api/services/scheduledActions.js';
import { calculateNextRunAt } from '../api/services/scheduleUtils.js';
import {
  evaluateLiveReadiness,
  parseLiveReadinessEnv,
  shouldUseExistingAccounts as shouldUseLiveExistingAccounts,
} from '../scripts/lib/consoleLiveReadiness.js';

describe('console scheduler helpers', () => {
  function numberFieldMax(featureId, key) {
    const field = getFeatureById(featureId)?.fields?.find((item) => item.key === key);
    if (!field || typeof field.max !== 'number') throw new Error(`${featureId}.${key} is missing a numeric max`);
    return field.max;
  }

  it('keeps console status labels aligned with the Japanese UI spec', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    for (const label of ['未連携', '確認のみ', '予約済み', '実行中', '完了', '失敗']) {
      expect(html).toContain(label);
    }
    expect(html).toContain("pending: '予約済み'");
    expect(html).toContain("active: '予約済み'");
  });

  it('lets scheduled actions choose dry-run or live mode from the schedule panel', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('data-schedule-mode="dryRun"');
    expect(html).toContain('data-schedule-mode="live"');
    expect(html).toContain('state.mode = button.dataset.scheduleMode');
  });

  it('keeps the mobile detail sheet controlled instead of always open', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('<aside class="detail" id="detail">');
    expect(html).toContain('id="detail-toggle"');
    expect(html).toContain('detailOpen: false');
    expect(html).toContain("els.detail.classList.toggle('open', state.detailOpen)");
    expect(html).toContain("els.detailToggle?.addEventListener('click'");
    expect(html).toContain('inset: auto 0 64px 0;');
    expect(html).toContain('state.detailOpen = true;');
  });

  it('uses an in-console confirmation modal for live and destructive actions', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('id="confirm-modal"');
    expect(html).toContain('function requestConfirmation');
    expect(html).toContain("title: '実行前の確認'");
    expect(html).toContain("title: '実行予約の確認'");
    expect(html).toContain("title: '再実行の確認'");
    expect(html).toContain("title: 'Xアカウントを削除'");
    expect(html).not.toContain('window.confirm');
  });

  it('makes the new console the default dashboard without deleting the old dashboard', () => {
    const server = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(server).toContain("app.get('/dashboard'");
    expect(server).toContain("res.redirect(302, '/console')");
    expect(server).toContain("app.get('/classic-dashboard'");
    expect(server).toContain("dashboard/index.html");
    expect(html).toContain('href="/classic-dashboard"');
    expect(html).not.toContain('href="/dashboard"');
    expect(html).toContain('従来版');
    expect(html).toContain('従来の操作');
    expect(html).not.toContain('旧ホーム');
    expect(html).not.toContain('旧アクション');
    expect(html).not.toContain('旧連携');
  });

  it('keeps schedule copy user-facing instead of implementation-facing', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');
    const scheduledActions = readFileSync(new URL('../api/services/scheduledActions.js', import.meta.url), 'utf8');
    const consoleRoute = readFileSync(new URL('../api/routes/console.js', import.meta.url), 'utf8');

    expect(html).toContain('function scheduleTypeLabel');
    expect(html).toContain("cron: '詳細指定'");
    expect(html).toContain('この機能に予約設定はありません。');
    expect(html).toContain('この機能は予約できません。');
    expect(html).not.toContain('コンソール予約にまだ対応していません');
    expect(scheduledActions).toContain('この機能は予約できません。');
    expect(consoleRoute).toContain('この機能はこの画面から実行できません。');
  });

  it('shows live readiness guidance for the final two-account verification', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('function liveReadiness()');
    expect(html).toContain('state.accountReadiness');
    expect(html).toContain('accountData.liveReadiness');
    expect(html).toContain('data-live-readiness');
    expect(html).toContain('複数アカウント実行の準備完了');
    expect(html).toContain('live検証には2件必要です');
    expect(html).toContain('2件のX連携で実行または予約できます');
  });

  it('builds server-side live readiness without exposing secrets', () => {
    const readiness = buildAccountLiveReadiness([
      { id: 'acc_1', username: 'a', status: 'active', lastVerifiedAt: new Date('2026-05-21T00:00:00Z') },
      { id: 'acc_2', username: 'b', status: 'active', lastVerifiedAt: null },
      { id: 'acc_3', username: 'c', status: 'expired', encryptedCookie: 'secret' },
    ]);

    expect(readiness).toMatchObject({
      ready: true,
      requiredAccounts: 2,
      totalAccounts: 3,
      activeAccounts: 2,
      verifiedActiveAccounts: 1,
      remainingAccounts: 0,
    });
    expect(JSON.stringify(readiness)).not.toContain('secret');

    const pending = buildAccountLiveReadiness([{ id: 'acc_1', status: 'active' }]);
    expect(pending.ready).toBe(false);
    expect(pending.remainingAccounts).toBe(1);
    expect(pending.nextAction).toContain('X連携を追加');
  });

  it('parses live readonly account selectors consistently', () => {
    const env = {
      XACTIONS_LIVE_ACCOUNT_IDS: 'acc_1, acc_2, acc_1',
      XACTIONS_LIVE_ACCOUNT_A_ID: 'acc_2',
      XACTIONS_LIVE_ACCOUNT_B_ID: 'acc_3',
      XACTIONS_LIVE_ACCOUNT_USERNAMES: '@Primary, SECONDARY',
      XACTIONS_LIVE_ACCOUNT_A_USERNAME: 'secondary',
      XACTIONS_LIVE_ACCOUNT_B_USERNAME: '@Third',
    };

    const parsed = parseLiveReadinessEnv(env);

    expect(parsed.requestedIds).toEqual(['acc_1', 'acc_2', 'acc_3']);
    expect(parsed.requestedUsernames).toEqual(['primary', 'secondary', 'third']);
    expect(parsed.selectorCount).toBe(2);
    expect(shouldUseLiveExistingAccounts(env)).toBe(true);
  });

  it('accepts live readonly only with distinct cookies or one valid existing-account selector', () => {
    const user = { id: 'user_1' };
    const activeAccounts = [
      { id: 'acc_1', username: 'primary', isDefault: true, lastVerifiedAt: new Date() },
      { id: 'acc_2', username: 'secondary', isDefault: false, lastVerifiedAt: new Date() },
    ];

    expect(evaluateLiveReadiness({
      env: {
        XACTIONS_LIVE_ACCOUNT_A_COOKIE: 'auth_token=a',
        XACTIONS_LIVE_ACCOUNT_B_COOKIE: 'auth_token=b',
      },
      user,
      activeAccounts: [],
      smokeUsername: 'smoke',
    }).ready).toBe(true);

    const duplicateCookies = evaluateLiveReadiness({
      env: {
        XACTIONS_LIVE_ACCOUNT_A_COOKIE: 'auth_token=a',
        XACTIONS_LIVE_ACCOUNT_B_COOKIE: 'auth_token=a',
      },
      user,
      activeAccounts,
      smokeUsername: 'smoke',
    });
    expect(duplicateCookies.ready).toBe(false);
    expect(duplicateCookies.reasons.join(' ')).toContain('must be different');

    const byIds = evaluateLiveReadiness({
      env: { XACTIONS_LIVE_ACCOUNT_IDS: 'acc_1,acc_2' },
      user,
      activeAccounts,
      smokeUsername: 'smoke',
    });
    expect(byIds.ready).toBe(true);
    expect(byIds.readyWithExistingAccounts).toBe(true);

    const mixedSelectors = evaluateLiveReadiness({
      env: {
        XACTIONS_LIVE_ACCOUNT_IDS: 'acc_1,acc_2',
        XACTIONS_LIVE_USE_EXISTING_ACCOUNTS: 'true',
      },
      user,
      activeAccounts,
      smokeUsername: 'smoke',
    });
    expect(mixedSelectors.ready).toBe(false);
    expect(mixedSelectors.reasons.join(' ')).toContain('Use only one existing-account selector');
  });

  it('auto-runs the host live readonly smoke when two active XAccounts exist', () => {
    const script = readFileSync(new URL('../scripts/run-console-live-readonly-host.sh', import.meta.url), 'utf8');

    expect(script).toContain('SOURCE="${XACTIONS_LIVE_READONLY_SOURCE:-auto}"');
    expect(script).toContain('auto|prompt|env|existing|diagnose');
    expect(script).toContain('active_xaccount_count()');
    expect(script).toContain('if [[ "$active_count" -ge 2 ]]; then');
    expect(script).toContain('run live readonly smoke: existing active XAccounts');
    expect(script).toContain('XACTIONS_LIVE_USE_EXISTING_ACCOUNTS=true');
  });

  it('does not block headless live readonly smoke on cookie prompts', () => {
    const script = readFileSync(new URL('../scripts/run-console-live-readonly-host.sh', import.meta.url), 'utf8');

    expect(script).toContain('prompt_and_run_with_cookie_stdin()');
    expect(script).toContain('[[ ! -t 0 ]]');
    expect(script).toContain('live readonly smoke is not ready for non-interactive execution.');
    expect(script).toContain('run with SOURCE=diagnose');
  });

  it('provides a safe operator path to register two live X accounts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const registerScript = readFileSync(new URL('../scripts/register-console-live-accounts.js', import.meta.url), 'utf8');
    const hostScript = readFileSync(new URL('../scripts/register-console-live-accounts-host.sh', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('../docs/console-live-smoke.md', import.meta.url), 'utf8');

    expect(pkg.scripts['register:console-live-accounts']).toBe('node scripts/register-console-live-accounts.js');
    expect(registerScript).toContain('for await (const chunk of process.stdin)');
    expect(registerScript).toContain('verifySessionCookie(account.cookie)');
    expect(registerScript).toContain('encryptedCookie: encrypt(account.cookie)');
    expect(registerScript).toContain('evaluateLiveReadiness');
    expect(registerScript).not.toContain('console.log(account.cookie');
    expect(registerScript).not.toContain('console.log(cookie');
    expect(hostScript).toContain('read -rsp "$prompt"');
    expect(hostScript).toContain('docker exec -i');
    expect(docs).toContain('register-console-live-accounts-host.sh');
    expect(docs).toContain("XACTIONS_LIVE_READONLY_SOURCE='existing'");
  });

  it('shows skipped run-now results and opens the run history', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('result.skipped ? (result.error ||');
    expect(html).toContain('await loadScheduleRuns(id);');
  });

  it('shows the next action for failed runs and unavailable accounts', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('function accountGuidance');
    expect(html).toContain('function nextActionText');
    expect(html).toContain('function detailWithGuidance');
    expect(html).toContain('次の操作:');
    expect(html).toContain('連携情報を更新して確認してください。');
    expect(html).toContain('前の実行が終わってから再実行してください。');
    expect(html).toContain('設定を見直してから再実行してください。');
    expect(html).toContain('detailWithGuidance(schedule.lastError, schedule.account)');
    expect(html).toContain('detailWithGuidance(operation.error, operation.account)');
    expect(html).toContain('detailWithGuidance(child.error, child.account)');
  });

  it('parses one-time Asia/Tokyo datetime values', () => {
    const nextRunAt = calculateNextRunAt(
      { type: 'once', runAt: '2026-05-21T18:00', timezone: 'Asia/Tokyo' },
      new Date('2026-05-21T00:00:00.000Z')
    );

    expect(nextRunAt.toISOString()).toBe('2026-05-21T09:00:00.000Z');
  });

  it('finds the next simple cron run', () => {
    const nextRunAt = calculateNextRunAt(
      { type: 'cron', cron: '*/30 * * * *' },
      new Date('2026-05-21T00:01:00.000Z')
    );

    expect(nextRunAt.toISOString()).toBe('2026-05-21T00:30:00.000Z');
  });

  it('keeps DM body out of operation config', () => {
    expect(getFeatureById('sendDM')).toMatchObject({
      operationType: 'sendDM',
      queueType: 'sendDM',
      supportsDryRun: false,
    });
    expect(() => createActionPayload(
      getFeatureById('sendDM'),
      { username: '@target_user', message: 'hello' },
      'dryRun'
    )).toThrow('DM送信は確認のみには対応していません。');

    const payload = createActionPayload(
      getFeatureById('sendDM'),
      { username: '@target_user', message: 'hello' },
      'live'
    );

    expect(payload.operationType).toBe('sendDM');
    expect(payload.operationConfig).toMatchObject({
      sourceFeatureId: 'sendDM',
      username: 'target_user',
      hasMessage: true,
      messageLength: 5,
    });
    expect(payload.operationConfig.message).toBeUndefined();
    expect(payload.jobConfig.message).toBe('hello');
  });

  it('marks target engagement DM payloads without queuing empty DM text', () => {
    const likeOnly = createActionPayload(
      getFeatureById('targetEngage'),
      { targetUsername: '@target_user', likeCount: 1, follow: false, dmMessage: '' },
      'live'
    );

    expect(likeOnly.jobConfig).toMatchObject({
      targetUsername: 'target_user',
      hasDmMessage: false,
    });
    expect(likeOnly.jobConfig.dmMessage).toBeUndefined();

    const withDm = createActionPayload(
      getFeatureById('targetEngage'),
      { targetUsername: '@target_user', likeCount: 0, follow: false, dmMessage: 'hello' },
      'live'
    );

    expect(withDm.jobConfig).toMatchObject({
      targetUsername: 'target_user',
      hasDmMessage: true,
      dmMessage: 'hello',
    });
    expect(withDm.operationConfig.dmMessage).toBeUndefined();
  });

  it('exposes X account management inside the console catalog', () => {
    const catalog = getPublicFeatureCatalog();
    const accounts = catalog.features.find((item) => item.id === 'accounts');

    expect(accounts).toMatchObject({
      category: 'settings',
      title: 'X連携',
      status: 'available',
      statusLabel: '利用可能',
    });
  });

  it('marks every catalog feature as available for the unified console', () => {
    const catalog = getPublicFeatureCatalog();
    const unavailable = catalog.features.filter((item) => item.status !== 'available');
    const missingAction = catalog.features.filter((item) => item.id !== 'accounts' && !item.consoleAction);
    const missingSchedule = catalog.features.filter((item) => item.id !== 'accounts' && item.consoleAction && !item.supportsSchedule);

    expect(unavailable).toEqual([]);
    expect(missingAction).toEqual([]);
    expect(missingSchedule).toEqual([]);
    expect(catalog.categories.every((category) => category.available === category.total)).toBe(true);
  });

  it('connects every console queue type to a worker processor', () => {
    const workerSource = readFileSync(new URL('../api/services/jobQueue.js', import.meta.url), 'utf8');
    const processors = new Set(
      [...workerSource.matchAll(/operationsQueue\.process\(['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
    );
    const requiredTypes = [...new Set(features
      .filter((feature) => feature.id !== 'accounts' && feature.consoleAction)
      .map((feature) => feature.queueType || feature.operationType))];

    expect(requiredTypes.filter((type) => !processors.has(type))).toEqual([]);
  });

  it('summarizes multi-account child operations for parent history', () => {
    const summary = summarizeChildStatuses([
      { status: 'completed' },
      { status: 'failed' },
    ]);

    expect(summary).toMatchObject({
      status: 'failed',
      terminal: true,
      error: '1件のアカウントで失敗しました。',
      counts: {
        total: 2,
        completed: 1,
        failed: 1,
      },
    });
  });

  it('serializes only live account jobs', () => {
    expect(shouldSerializeAccountJob({
      accountId: 'acc_1',
      config: { dryRun: false },
    })).toBe(true);

    expect(shouldSerializeAccountJob({
      accountId: 'acc_1',
      config: { dryRun: true },
    })).toBe(false);

    expect(shouldSerializeAccountJob({
      config: { dryRun: false },
    })).toBe(false);
  });

  it('throttles only live DM and follow account jobs', () => {
    expect(shouldThrottleAccountJob({
      type: 'sendDM',
      accountId: 'acc_1',
      config: { dryRun: false },
    })).toBe(true);

    expect(shouldThrottleAccountJob({
      type: 'followEngagers',
      accountId: 'acc_1',
      config: { dryRun: false },
    })).toBe(true);

    expect(shouldThrottleAccountJob({
      type: 'targetEngage',
      accountId: 'acc_1',
      config: { dryRun: false, follow: true },
    })).toBe(true);

    expect(shouldThrottleAccountJob({
      type: 'targetEngage',
      accountId: 'acc_1',
      config: { dryRun: false, hasDmMessage: true },
    })).toBe(true);

    expect(shouldThrottleAccountJob({
      type: 'targetEngage',
      accountId: 'acc_1',
      config: { dryRun: false, follow: false, hasDmMessage: false },
    })).toBe(false);

    expect(shouldThrottleAccountJob({
      type: 'sendDM',
      accountId: 'acc_1',
      config: { dryRun: true },
    })).toBe(false);
  });

  it('applies a Redis cooldown after high-risk live account jobs', async () => {
    const redis = {
      store: new Map(),
      pttls: [2, -2],
      pttlKeys: [],
      cooldowns: [],
      setCalls: [],
      async set(key, value, ...args) {
        this.setCalls.push({ key, value, args });
        if (args.includes('NX') && this.store.has(key)) return null;
        this.store.set(key, value);
        return 'OK';
      },
      async pttl(key) {
        this.pttlKeys.push(key);
        return this.pttls.length ? this.pttls.shift() : -2;
      },
      async psetex(key, ttlMs, value) {
        this.cooldowns.push({ key, ttlMs, value });
        this.store.set(key, value);
        return 'OK';
      },
      async eval(script, _keyCount, key, token) {
        if (script.includes('del')) {
          if (this.store.get(key) === token) {
            this.store.delete(key);
            return 1;
          }
          return 0;
        }
        return 1;
      },
    };
    const progress = [];

    const result = await withAccountExecutionLock(
      redis,
      {
        id: 'job_1',
        data: {
          type: 'sendDM',
          operationId: 'op_1',
          accountId: 'acc_1',
          config: { dryRun: false },
        },
        progress: async (message) => progress.push(message),
      },
      async () => 'ok',
      { cooldownMs: 5, cooldownWaitMs: 50, waitMs: 1, ttlMs: 30000 }
    );

    expect(result).toBe('ok');
    expect(progress.join(' ')).toContain('直列化');
    expect(redis.pttlKeys).toEqual([cooldownKey('acc_1'), cooldownKey('acc_1')]);
    expect(redis.cooldowns).toHaveLength(1);
    expect(redis.cooldowns[0]).toMatchObject({
      key: cooldownKey('acc_1'),
      ttlMs: 5,
    });
  });

  it('removes session material from queued job payloads', () => {
    const jobData = sanitizeQueueJobData({
      type: 'getProfile',
      operationId: 'op_1',
      userId: 'user_1',
      authMethod: 'oauth',
      config: {
        username: 'source_user',
        sessionCookie: 'auth_token=secret',
        nested: {
          refreshToken: 'refresh-secret',
          keep: 'visible',
        },
      },
    });

    expect(jobData.authMethod).toBe('session');
    expect(jobData.config).toEqual({
      username: 'source_user',
      nested: {
        keep: 'visible',
      },
    });
    expect(JSON.stringify(jobData)).not.toContain('secret');
  });

  it('encrypts user-authored bodies before they reach Bull job data', () => {
    const expectEncryptedConfigField = (jobData, field, secret) => {
      expect(jobData.config[field]).toBeUndefined();
      expect(jobData.encryptedJobConfig).toBeTruthy();
      expect(JSON.stringify(jobData)).not.toContain(secret);
      expect(restoreQueueJobConfig(jobData)[field]).toEqual(secret);
    };

    const sendDmJobData = sanitizeQueueJobData({
      type: 'sendDM',
      operationId: 'op_dm',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        username: 'target_user',
        message: 'private dm body',
        dryRun: false,
      },
    });

    expect(sendDmJobData.config).toEqual({
      username: 'target_user',
      dryRun: false,
    });
    expect(sendDmJobData.encryptedJobConfig).toBeTruthy();
    expect(JSON.stringify(sendDmJobData)).not.toContain('private dm body');
    expect(restoreQueueJobConfig(sendDmJobData)).toMatchObject({
      username: 'target_user',
      message: 'private dm body',
      dryRun: false,
    });

    const targetEngageJobData = sanitizeQueueJobData({
      type: 'targetEngage',
      operationId: 'op_target',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        targetUsername: 'target_user',
        likeCount: 0,
        follow: false,
        dmMessage: 'private target dm',
        dryRun: false,
      },
    });

    expect(targetEngageJobData.config.dmMessage).toBeUndefined();
    expect(JSON.stringify(targetEngageJobData)).not.toContain('private target dm');
    expect(restoreQueueJobConfig(targetEngageJobData).dmMessage).toBe('private target dm');

    expectEncryptedConfigField(sanitizeQueueJobData({
      type: 'postTweet',
      operationId: 'op_post',
      userId: 'user_1',
      accountId: 'account_1',
      config: { text: 'private post body', dryRun: true },
    }), 'text', 'private post body');

    expectEncryptedConfigField(sanitizeQueueJobData({
      type: 'replyToTweet',
      operationId: 'op_reply',
      userId: 'user_1',
      accountId: 'account_1',
      config: { tweetId: '123', text: 'private reply body' },
    }), 'text', 'private reply body');

    expectEncryptedConfigField(sanitizeQueueJobData({
      type: 'autoComment',
      operationId: 'op_comment',
      userId: 'user_1',
      accountId: 'account_1',
      config: { query: 'xactions', comment: 'private comment body', dryRun: false },
    }), 'comment', 'private comment body');

    const pollJobData = sanitizeQueueJobData({
      type: 'createPoll',
      operationId: 'op_poll',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        question: 'private poll question',
        options: ['private poll option a', 'private poll option b'],
      },
    });

    expect(pollJobData.config.question).toBeUndefined();
    expect(pollJobData.config.options).toBeUndefined();
    expect(JSON.stringify(pollJobData)).not.toContain('private poll question');
    expect(JSON.stringify(pollJobData)).not.toContain('private poll option a');
    expect(restoreQueueJobConfig(pollJobData)).toMatchObject({
      question: 'private poll question',
      options: ['private poll option a', 'private poll option b'],
    });

    const workflowJobData = sanitizeQueueJobData({
      type: 'runWorkflow',
      operationId: 'op_workflow',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        action: 'run',
        workflowId: 'workflow_1',
        context: { prompt: 'private workflow context' },
      },
    });

    expect(workflowJobData.config.context).toBeUndefined();
    expect(JSON.stringify(workflowJobData)).not.toContain('private workflow context');
    expect(restoreQueueJobConfig(workflowJobData).context).toEqual({ prompt: 'private workflow context' });
  });

  it('keeps full DM text out of the legacy messages history config', () => {
    const route = readFileSync(new URL('../api/routes/messages.js', import.meta.url), 'utf8');

    expect(route).toContain('messageLength: String(message).length');
    expect(route).toContain('hasMessage: true');
    expect(route).not.toContain('config: JSON.stringify({ username, message })');
  });

  it('redacts raw configs from legacy operation status and list routes', () => {
    const route = readFileSync(new URL('../api/routes/operations.js', import.meta.url), 'utf8');
    const sanitized = sanitizeOperation({
      config: JSON.stringify({
        message: 'private dm body',
        text: 'private post body',
        sessionCookie: 'auth_token=secret',
        keep: 'visible',
      }),
    });

    expect(route).toContain("import { sanitizeOperation } from '../services/consoleActions.js'");
    expect(route).toContain('res.json(sanitizeOperation(operation))');
    expect(route).toContain('operations: operations.map(sanitizeOperation)');
    expect(sanitized.config).toEqual({
      message: '[hidden]',
      text: '[hidden]',
      sessionCookie: '[hidden]',
      keep: 'visible',
    });
  });

  it('keeps legacy DM route responses user-facing in Japanese', () => {
    const route = readFileSync(new URL('../api/routes/messages.js', import.meta.url), 'utf8');

    for (const text of [
      'X連携が必要です。',
      '送信先と本文を入力してください。',
      'DM送信を予約しました。',
      '会話一覧の取得を予約しました。',
      'DMエクスポートを予約しました。',
    ]) {
      expect(route).toContain(text);
    }

    for (const text of [
      'Twitter account not connected',
      'Username and message are required',
      'DM queued',
      'Conversations fetch queued',
      'DM export queued',
      'Failed to send DM',
    ]) {
      expect(route).not.toContain(text);
    }
  });

  it('keeps legacy and console DM operations visible in the DM history filter', () => {
    expect(operationMatchesFeatureHistory({
      type: 'sendDM',
      config: { hasMessage: true },
    }, 'sendDM')).toBe(true);

    expect(operationMatchesFeatureHistory({
      type: 'sendDM',
      config: { sourceFeatureId: 'sendDM', hasMessage: true },
    }, 'sendDM')).toBe(true);

    expect(operationMatchesFeatureHistory({
      type: 'targetEngage',
      config: { sourceFeatureId: 'targetEngage', hasDmMessage: true },
    }, 'sendDM')).toBe(true);

    expect(operationMatchesFeatureHistory({
      type: 'targetEngage',
      config: { sourceFeatureId: 'targetEngage', hasDmMessage: false },
    }, 'sendDM')).toBe(false);
  });

  it('detects X session expiration errors', () => {
    expect(isSessionExpiredError(new Error('Session expired - please reconnect your X account'))).toBe(true);
    expect(isSessionExpiredError('X連携情報でログイン状態を確認できませんでした。')).toBe(true);
    expect(isSessionExpiredError(new Error('Like button not found'))).toBe(false);
  });

  it('pauses schedules when an account becomes unavailable', () => {
    expect(shouldPauseSchedulesForAccountStatus('active')).toBe(false);
    expect(shouldPauseSchedulesForAccountStatus('expired')).toBe(true);
    expect(shouldPauseSchedulesForAccountStatus('error')).toBe(true);
    expect(shouldPauseSchedulesForAccountStatus('disabled')).toBe(true);
    expect(accountPauseMessage('disabled')).toBe('Xアカウントを停止したため予約を停止しました。');
  });

  it('requires explicit account selection for account actions', () => {
    expect(explicitAccountIdsFromBody({ accountId: 'acc_1' })).toEqual(['acc_1']);
    expect(explicitAccountIdsFromBody({ accountIds: ['acc_1', 'acc_1', ' acc_2 '] })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromBody({})).toEqual([]);
    expect(explicitAccountIdsFromQuery({ accountId: 'acc_1' })).toEqual(['acc_1']);
    expect(explicitAccountIdsFromQuery({ accountIds: 'acc_1', accountId: 'acc_2' })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromQuery({ accountIds: 'acc_1, acc_2', accountId: 'acc_2' })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromQuery({})).toEqual([]);
    expect(() => assertAccountSelectionLimit(['acc_1', 'acc_2'])).not.toThrow();
    expect(() => assertAccountSelectionLimit(['acc_1', 'acc_2', 'acc_3'])).toThrow(
      `一度に選べるXアカウントは${MAX_ACCOUNT_SELECTION}件までです。`
    );
  });

  it('uses one account query parser for history and schedule filters', () => {
    const consoleRoute = readFileSync(new URL('../api/routes/console.js', import.meta.url), 'utf8');
    const scheduleRoute = readFileSync(new URL('../api/routes/scheduled-actions.js', import.meta.url), 'utf8');

    expect(consoleRoute).toContain('explicitAccountIdsFromQuery(req.query)');
    expect(scheduleRoute).toContain('explicitAccountIdsFromQuery(req.query)');
  });

  it('keeps batch parent operations visible when filtering history by account', () => {
    expect(operationAccountHistoryWhere(['acc_1'])).toEqual({
      OR: [
        { accountId: 'acc_1' },
        { childOperations: { some: { accountId: 'acc_1' } } },
      ],
    });

    expect(operationAccountHistoryWhere(['acc_1', 'acc_2'])).toEqual({
      OR: [
        { accountId: { in: ['acc_1', 'acc_2'] } },
        { childOperations: { some: { accountId: { in: ['acc_1', 'acc_2'] } } } },
      ],
    });
  });

  it('stores batch retry inputs encrypted and hides them from history output', () => {
    const retryConfig = {
      message: 'secret dm body',
      text: 'secret post body',
      tweets: 'first\n---\nsecond',
    };
    const stored = buildEncryptedRetryConfig(retryConfig);

    expect(stored.hasRetryConfig).toBe(true);
    expect(stored.encryptedRetryConfig).toBeTruthy();
    expect(stored.encryptedRetryConfig).not.toContain('secret');
    expect(decryptRetryConfig(stored)).toEqual(retryConfig);
    expect(recoverRetryConfig({ ...stored, textPreview: 'secret' }, { text: 'override text' })).toMatchObject({
      message: 'secret dm body',
      text: 'override text',
      tweets: 'first\n---\nsecond',
      textPreview: 'secret',
    });
    expect(sanitizeConfig(stored)).toMatchObject({
      encryptedRetryConfig: '[hidden]',
      hasRetryConfig: true,
    });
  });

  it('connects follower cleanup actions to the console catalog', () => {
    const nonFollowers = getFeatureById('unfollowNonFollowers');
    const everyone = getFeatureById('unfollowEveryone');

    expect(nonFollowers).toMatchObject({
      status: 'available',
      consoleAction: 'unfollowNonFollowers',
      supportsDryRun: true,
      supportsSchedule: true,
    });
    expect(everyone).toMatchObject({
      status: 'available',
      consoleAction: 'unfollowEveryone',
      supportsDryRun: true,
      supportsSchedule: true,
    });
  });

  it('builds safe dry-run payloads for follower cleanup actions', () => {
    const payload = createActionPayload(
      getFeatureById('unfollowNonFollowers'),
      { maxUsers: 200, limit: 10 },
      'dryRun'
    );

    expect(payload.operationType).toBe('unfollowNonFollowers');
    expect(payload.operationConfig).toMatchObject({
      sourceFeatureId: 'unfollowNonFollowers',
      maxUsers: 200,
      limit: 10,
      dryRun: true,
    });
    expect(payload.jobConfig).toMatchObject({
      maxUsers: 200,
      limit: 10,
      dryRun: true,
    });
  });

  it('enforces catalog bulk limits in server-side console payloads', () => {
    const targetFeature = getFeatureById('targetEngage');
    const delayField = targetFeature.fields.find((field) => field.label === '実行間隔');
    expect(delayField).toMatchObject({
      key: 'delaySeconds',
      min: 2,
      max: 60,
      suffix: '秒',
    });

    const targetEngage = createActionPayload(
      targetFeature,
      { targetUsername: '@target_user', likeCount: 999, delaySeconds: 1 },
      'dryRun'
    );
    expect(targetEngage.operationConfig.likeCount).toBe(numberFieldMax('targetEngage', 'likeCount'));
    expect(targetEngage.operationConfig.delayMs).toBe(2000);

    const legacyDelay = createActionPayload(
      targetFeature,
      { targetUsername: '@target_user', likeCount: 1, delayMs: 1 },
      'dryRun'
    );
    expect(legacyDelay.operationConfig.delayMs).toBe(2000);

    for (const [featureId, config, key] of [
      ['autoLike', { query: 'xactions', maxLikes: 999 }, 'maxLikes'],
      ['followEngagers', { tweetUrl: 'https://x.com/source/status/1234567890', maxFollows: 999 }, 'maxFollows'],
      ['keywordFollow', { query: 'xactions', maxFollows: 999 }, 'maxFollows'],
      ['autoComment', { query: 'xactions', comment: '確認用コメント', maxComments: 999 }, 'maxComments'],
    ]) {
      const payload = createActionPayload(getFeatureById(featureId), config, 'dryRun');
      expect(payload.operationConfig[key]).toBe(numberFieldMax(featureId, key));
      expect(payload.jobConfig[key]).toBe(numberFieldMax(featureId, key));
    }

    for (const featureId of ['unfollowNonFollowers', 'unfollowEveryone']) {
      const payload = createActionPayload(
        getFeatureById(featureId),
        { maxUsers: 999999, limit: 999999 },
        'live'
      );
      expect(payload.operationConfig.maxUsers).toBe(numberFieldMax(featureId, 'maxUsers'));
      expect(payload.operationConfig.limit).toBe(numberFieldMax(featureId, 'limit'));
      expect(payload.jobConfig.maxUsers).toBe(numberFieldMax(featureId, 'maxUsers'));
      expect(payload.jobConfig.limit).toBe(numberFieldMax(featureId, 'limit'));
    }
  });

  it('keeps DM sending focused and caps user-authored DM bodies server-side', () => {
    const sendDm = getFeatureById('sendDM');
    expect(sendDm.fields.map((field) => field.key)).toEqual(['username', 'message']);

    const longMessage = '長'.repeat(numberFieldMax('sendDM', 'message') + 50);
    const payload = createActionPayload(
      sendDm,
      { username: '@target_user', message: longMessage },
      'live'
    );
    expect(payload.operationConfig.messageLength).toBe(numberFieldMax('sendDM', 'message'));
    expect(payload.jobConfig.message).toHaveLength(numberFieldMax('sendDM', 'message'));

    const engage = createActionPayload(
      getFeatureById('targetEngage'),
      { targetUsername: '@target_user', dmMessage: longMessage },
      'live'
    );
    expect(engage.jobConfig.dmMessage).toHaveLength(numberFieldMax('targetEngage', 'dmMessage'));
  });

  it('connects growth actions with safe console payloads', () => {
    expect(getFeatureById('followEngagers')).toMatchObject({
      status: 'available',
      consoleAction: 'followEngagers',
      supportsDryRun: true,
    });
    expect(getFeatureById('keywordFollow')).toMatchObject({
      status: 'available',
      consoleAction: 'keywordFollow',
      supportsDryRun: true,
    });
    expect(getFeatureById('autoComment')).toMatchObject({
      status: 'available',
      consoleAction: 'autoComment',
      supportsDryRun: true,
    });

    const commentPayload = createActionPayload(
      getFeatureById('autoComment'),
      { query: 'xactions', comment: '確認用コメント', maxComments: 2 },
      'dryRun'
    );

    expect(commentPayload.operationType).toBe('autoComment');
    expect(commentPayload.operationConfig).toMatchObject({
      hasComment: true,
      maxComments: 2,
      dryRun: true,
    });
    expect(commentPayload.operationConfig.comment).toBeUndefined();
    expect(commentPayload.jobConfig.comment).toBe('確認用コメント');
  });

  it('connects read-only collection actions to the console catalog', () => {
    for (const id of [
      'getProfile',
      'getFollowers',
      'getFollowing',
      'getTweets',
      'searchTweets',
      'searchHashtag',
      'getTrends',
      'getExploreFeed',
      'getBookmarks',
      'getMedia',
      'getConversations',
    ]) {
      const featureId = {
        getProfile: 'profile',
        getFollowers: 'followers',
        getFollowing: 'following',
        getTweets: 'tweets',
        searchTweets: 'searchTweets',
        searchHashtag: 'hashtag',
        getTrends: 'trends',
        getExploreFeed: 'explore',
        getBookmarks: 'bookmarks',
        getMedia: 'media',
        getConversations: 'conversations',
      }[id];
      expect(getFeatureById(featureId)).toMatchObject({
        status: 'available',
        consoleAction: id,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }
  });

  it('builds payloads for read-only collection actions', () => {
    const profile = createActionPayload(
      getFeatureById('profile'),
      { username: '@target_user' },
      'live'
    );
    expect(profile).toMatchObject({
      operationType: 'getProfile',
      jobConfig: {
        username: 'target_user',
        dryRun: true,
      },
    });

    const followers = createActionPayload(
      getFeatureById('followers'),
      { username: '@target_user', limit: 20 },
      'dryRun'
    );
    expect(followers).toMatchObject({
      operationType: 'getFollowers',
      jobConfig: {
        username: 'target_user',
        limit: 20,
        dryRun: true,
      },
    });

    const following = createActionPayload(
      getFeatureById('following'),
      { username: '@target_user', limit: 25 },
      'live'
    );
    expect(following).toMatchObject({
      operationType: 'getFollowing',
      operationConfig: {
        sourceFeatureId: 'following',
        username: 'target_user',
        limit: 25,
        dryRun: true,
      },
    });

    const tweets = createActionPayload(
      getFeatureById('tweets'),
      { username: '@target_user', limit: 15, includeReplies: 'true' },
      'dryRun'
    );
    expect(tweets).toMatchObject({
      operationType: 'getTweets',
      operationConfig: {
        sourceFeatureId: 'tweets',
        username: 'target_user',
        limit: 15,
        includeReplies: true,
        dryRun: true,
      },
    });

    const search = createActionPayload(
      getFeatureById('searchTweets'),
      { query: 'xactions', limit: 5, filter: 'top' },
      'dryRun'
    );
    expect(search).toMatchObject({
      operationType: 'searchTweets',
      jobConfig: {
        query: 'xactions',
        limit: 5,
        filter: 'top',
        dryRun: true,
      },
    });

    const hashtag = createActionPayload(
      getFeatureById('hashtag'),
      { hashtag: '#xactions', limit: 30, filter: 'top' },
      'dryRun'
    );
    expect(hashtag).toMatchObject({
      operationType: 'searchHashtag',
      operationConfig: {
        sourceFeatureId: 'hashtag',
        hashtag: 'xactions',
        limit: 30,
        filter: 'top',
        dryRun: true,
      },
    });

    const explore = createActionPayload(
      getFeatureById('explore'),
      { tab: 'news', limit: 10 },
      'dryRun'
    );
    expect(explore).toMatchObject({
      operationType: 'getExploreFeed',
      operationConfig: {
        sourceFeatureId: 'explore',
        tab: 'news',
        limit: 10,
        dryRun: true,
      },
    });

    const media = createActionPayload(
      getFeatureById('media'),
      { username: '@target_user', limit: 12, type: 'videos' },
      'dryRun'
    );
    expect(media).toMatchObject({
      operationType: 'getMedia',
      operationConfig: {
        sourceFeatureId: 'media',
        username: 'target_user',
        limit: 12,
        type: 'videos',
        dryRun: true,
      },
    });
  });

  it('connects legacy route-backed actions to the console catalog', () => {
    for (const [id, action] of [
      ['exportDMs', 'exportDMs'],
      ['followerScan', 'followerScan'],
      ['spaces', 'getSpaces'],
      ['analytics', 'analyzeSentiment'],
      ['priceCorrelation', 'priceCorrelation'],
      ['datasets', 'datasets'],
    ]) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: action,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }
  });

  it('builds payloads for legacy route-backed actions', () => {
    const exportDms = createActionPayload(
      getFeatureById('exportDMs'),
      { conversationUrl: 'https://x.com/messages/1-2', limit: 50, format: 'csv' },
      'dryRun'
    );
    expect(exportDms).toMatchObject({
      operationType: 'exportDMs',
      operationConfig: {
        sourceFeatureId: 'exportDMs',
        hasConversationUrl: true,
        limit: 50,
        format: 'csv',
        dryRun: true,
      },
      jobConfig: {
        conversationUrl: 'https://x.com/messages/1-2',
        limit: 50,
        format: 'csv',
        dryRun: true,
      },
    });

    const scan = createActionPayload(
      getFeatureById('followerScan'),
      { username: '@source_user', limit: 250 },
      'live'
    );
    expect(scan).toMatchObject({
      operationType: 'followerScan',
      operationConfig: {
        username: 'source_user',
        limit: 250,
        dryRun: true,
      },
    });

    const liveSpaces = createActionPayload(
      getFeatureById('spaces'),
      { mode: 'live', topic: 'xactions', limit: 10 },
      'dryRun'
    );
    expect(liveSpaces).toMatchObject({
      operationType: 'getLiveSpaces',
      jobConfig: {
        mode: 'live',
        topic: 'xactions',
        limit: 10,
        dryRun: true,
      },
    });

    const scheduledSpaces = createActionPayload(
      getFeatureById('spaces'),
      { mode: 'scheduled', username: '@host_user', limit: 10 },
      'dryRun'
    );
    expect(scheduledSpaces).toMatchObject({
      operationType: 'getScheduledSpaces',
      jobConfig: {
        mode: 'scheduled',
        username: 'host_user',
        limit: 10,
        dryRun: true,
      },
    });

    const scrapedSpace = createActionPayload(
      getFeatureById('spaces'),
      { mode: 'scrape', spaceUrl: 'https://x.com/i/spaces/1DXxyjWmQnZKM', limit: 10 },
      'dryRun'
    );
    expect(scrapedSpace).toMatchObject({
      operationType: 'scrapeSpace',
      jobConfig: {
        mode: 'scrape',
        spaceUrl: 'https://x.com/i/spaces/1DXxyjWmQnZKM',
        limit: 10,
        dryRun: true,
      },
    });

    const sentiment = createActionPayload(
      getFeatureById('analytics'),
      { text: 'This is useful', mode: 'rules' },
      'dryRun'
    );
    expect(sentiment.operationType).toBe('analyzeSentiment');
    expect(sentiment.operationConfig.text).toBeUndefined();
    expect(sentiment.operationConfig.textLength).toBe(14);
    expect(sentiment.jobConfig.text).toBe('This is useful');

    const price = createActionPayload(
      getFeatureById('priceCorrelation'),
      {
        tweets: JSON.stringify([{ timestamp: 1710000000000, text: 'hello' }]),
        tokenId: 'bitcoin',
        windows: '1,24',
      },
      'dryRun'
    );
    expect(price.operationConfig).toMatchObject({
      tweetCount: 1,
      tokenId: 'bitcoin',
      windows: [1, 24],
      dryRun: true,
    });
    expect(price.operationConfig.tweets).toBeUndefined();
    expect(price.jobConfig.tweets).toEqual([{ timestamp: 1710000000000, text: 'hello', url: undefined }]);

    const datasets = createActionPayload(
      getFeatureById('datasets'),
      { action: 'get', name: 'sample', offset: 5, limit: 10 },
      'dryRun'
    );
    expect(datasets).toMatchObject({
      operationType: 'datasets',
      jobConfig: {
        action: 'get',
        name: 'sample',
        offset: 5,
        limit: 10,
        dryRun: true,
      },
    });
  });

  it('connects analytics features to the unified console', () => {
    for (const [id, action] of [
      ['engagementAnalysis', 'analyzeEngagement'],
      ['growthHistory', 'growthHistory'],
      ['audienceOverlap', 'audienceOverlap'],
      ['bestPostTime', 'bestPostTime'],
      ['analyticsReport', 'analyticsReport'],
    ]) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: action,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }
  });

  it('builds payloads for analytics features', () => {
    const engagement = createActionPayload(
      getFeatureById('engagementAnalysis'),
      { username: '@target_user', tweetCount: 30, includeReplies: true },
      'dryRun'
    );
    expect(engagement).toMatchObject({
      operationType: 'analyzeEngagement',
      operationConfig: {
        sourceFeatureId: 'engagementAnalysis',
        username: 'target_user',
        tweetCount: 30,
        includeReplies: true,
        dryRun: true,
      },
      jobConfig: {
        username: 'target_user',
        tweetCount: 30,
        includeReplies: true,
        dryRun: true,
      },
    });

    const growth = createActionPayload(
      getFeatureById('growthHistory'),
      { username: '@target_user', days: 90, interval: 'week' },
      'dryRun'
    );
    expect(growth).toMatchObject({
      operationType: 'growthHistory',
      operationConfig: {
        sourceFeatureId: 'growthHistory',
        username: 'target_user',
        days: 90,
        interval: 'week',
        dryRun: true,
      },
    });

    const overlap = createActionPayload(
      getFeatureById('audienceOverlap'),
      { username1: '@target_user', username2: '@source_user', limit: 250 },
      'live'
    );
    expect(overlap).toMatchObject({
      operationType: 'audienceOverlap',
      operationConfig: {
        sourceFeatureId: 'audienceOverlap',
        username1: 'target_user',
        username2: 'source_user',
        limit: 250,
        dryRun: true,
      },
    });

    const bestTime = createActionPayload(
      getFeatureById('bestPostTime'),
      { username: '@target_user', tweetCount: 60 },
      'dryRun'
    );
    expect(bestTime).toMatchObject({
      operationType: 'bestPostTime',
      operationConfig: {
        sourceFeatureId: 'bestPostTime',
        username: 'target_user',
        tweetCount: 60,
        dryRun: true,
      },
    });

    const report = createActionPayload(
      getFeatureById('analyticsReport'),
      { username: '@target_user', tweetCount: 60, days: 14 },
      'dryRun'
    );
    expect(report).toMatchObject({
      operationType: 'analyticsReport',
      operationConfig: {
        sourceFeatureId: 'analyticsReport',
        username: 'target_user',
        tweetCount: 60,
        days: 14,
        dryRun: true,
      },
    });
  });

  it('connects monitor and workflow automation actions to the console catalog', () => {
    expect(getFeatureById('monitor')).toMatchObject({
      status: 'available',
      consoleAction: 'monitorSnapshot',
      operationType: 'monitorSnapshot',
      supportsDryRun: true,
      supportsSchedule: true,
    });
    expect(getFeatureById('workflows')).toMatchObject({
      status: 'available',
      consoleAction: 'runWorkflow',
      operationType: 'runWorkflow',
      supportsDryRun: true,
      supportsSchedule: true,
    });
  });

  it('builds payloads for monitor and workflow automation actions', () => {
    const monitor = createActionPayload(
      getFeatureById('monitor'),
      { target: '@source_user', monitorType: 'replies', limit: 12, sentimentMode: 'rules' },
      'dryRun'
    );
    expect(monitor).toMatchObject({
      operationType: 'monitorSnapshot',
      operationConfig: {
        sourceFeatureId: 'monitor',
        target: '@source_user',
        monitorType: 'replies',
        limit: 12,
        sentimentMode: 'rules',
        dryRun: true,
      },
      jobConfig: {
        target: '@source_user',
        monitorType: 'replies',
        limit: 12,
        sentimentMode: 'rules',
        dryRun: true,
      },
    });

    const workflowPreview = createActionPayload(
      getFeatureById('workflows'),
      { action: 'run', workflowId: 'wf_1', context: '{"keyword":"xactions"}' },
      'dryRun'
    );
    expect(workflowPreview).toMatchObject({
      operationType: 'runWorkflow',
      operationConfig: {
        sourceFeatureId: 'workflows',
        action: 'run',
        workflowId: 'wf_1',
        hasContext: true,
        dryRun: true,
      },
      jobConfig: {
        action: 'run',
        workflowId: 'wf_1',
        context: { keyword: 'xactions' },
        dryRun: true,
      },
    });

    const workflowRun = createActionPayload(
      getFeatureById('workflows'),
      { action: 'run', workflowId: 'wf_1' },
      'live'
    );
    expect(workflowRun.operationConfig.dryRun).toBe(false);
    expect(workflowRun.jobConfig.dryRun).toBe(false);
  });

  it('connects agent and portability actions to the console catalog', () => {
    expect(getFeatureById('agent')).toMatchObject({
      status: 'available',
      consoleAction: 'agentCommand',
      operationType: 'agentCommand',
      accountRequired: true,
      supportsSchedule: true,
    });
    expect(getFeatureById('portability')).toMatchObject({
      status: 'available',
      consoleAction: 'portability',
      operationType: 'portability',
      accountRequired: true,
      supportsSchedule: true,
    });
  });

  it('builds payloads for agent and portability actions', () => {
    const agent = createActionPayload(
      getFeatureById('agent'),
      { action: 'score', text: 'Relevant post text', days: 7, limit: 5 },
      'dryRun'
    );
    expect(agent).toMatchObject({
      operationType: 'agentCommand',
      operationConfig: {
        sourceFeatureId: 'agent',
        action: 'score',
        hasText: true,
        days: 7,
        limit: 5,
        dryRun: true,
      },
      jobConfig: {
        action: 'score',
        text: 'Relevant post text',
        days: 7,
        limit: 5,
        dryRun: true,
      },
    });
    expect(agent.operationConfig.text).toBeUndefined();

    const portability = createActionPayload(
      getFeatureById('portability'),
      { action: 'export', username: '@source_user', formats: 'json,md', only: 'profile,tweets', limit: 100 },
      'live'
    );
    expect(portability).toMatchObject({
      operationType: 'portability',
      operationConfig: {
        sourceFeatureId: 'portability',
        action: 'export',
        username: 'source_user',
        formats: ['json', 'md'],
        only: ['profile', 'tweets'],
        limit: 100,
        dryRun: false,
      },
      jobConfig: {
        action: 'export',
        username: 'source_user',
        formats: ['json', 'md'],
        only: ['profile', 'tweets'],
        limit: 100,
        dryRun: false,
      },
    });

    const diff = createActionPayload(
      getFeatureById('portability'),
      { action: 'diff', dirA: 'older', dirB: 'newer' },
      'dryRun'
    );
    expect(diff.operationConfig).toMatchObject({
      action: 'diff',
      hasDiffDirs: true,
      dryRun: true,
    });
  });

  it('connects posting actions without storing full post text in operation config', () => {
    for (const id of ['postTweet', 'postThread', 'createPoll', 'schedulePost']) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: id === 'schedulePost' ? 'postTweet' : id,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }

    const tweet = createActionPayload(
      getFeatureById('postTweet'),
      { text: '公開本文'.repeat(30), replyTo: 'https://x.com/a/status/1' },
      'dryRun'
    );
    expect(tweet.operationType).toBe('postTweet');
    expect(tweet.operationConfig.textLength).toBeGreaterThan(0);
    expect(tweet.operationConfig.textPreview).toBeUndefined();
    expect(tweet.operationConfig.text).toBeUndefined();
    expect(tweet.operationConfig.hasReplyTo).toBe(true);
    expect(tweet.jobConfig.text).toContain('公開本文');

    const scheduledTweet = createActionPayload(
      getFeatureById('schedulePost'),
      { text: '予約本文' },
      'dryRun'
    );
    expect(scheduledTweet.operationType).toBe('postTweet');
    expect(scheduledTweet.operationConfig.sourceFeatureId).toBe('schedulePost');
    expect(scheduledTweet.operationConfig.text).toBeUndefined();
    expect(scheduledTweet.jobConfig.text).toBe('予約本文');

    const thread = createActionPayload(
      getFeatureById('postThread'),
      { tweets: '1つ目\n---\n2つ目' },
      'dryRun'
    );
    expect(thread.operationConfig).toMatchObject({
      tweetCount: 2,
      dryRun: true,
    });
    expect(thread.operationConfig.previews).toBeUndefined();
    expect(thread.operationConfig.tweets).toBeUndefined();
    expect(thread.jobConfig.tweets).toEqual(['1つ目', '2つ目']);

    const poll = createActionPayload(
      getFeatureById('createPoll'),
      { question: 'どちらですか？', options: 'A\nB', durationMinutes: 60 },
      'dryRun'
    );
    expect(poll.operationConfig).toMatchObject({
      questionLength: 'どちらですか？'.length,
      optionCount: 2,
      durationMinutes: 60,
      dryRun: true,
    });
    expect(poll.operationConfig.questionPreview).toBeUndefined();
    expect(poll.operationConfig.options).toBeUndefined();
    expect(poll.jobConfig.options).toEqual(['A', 'B']);
  });

  it('connects reply, bookmark, and delete actions for live console execution', () => {
    for (const id of ['replyToTweet', 'bookmarkTweet', 'deleteTweet']) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: id,
        accountRequired: true,
        supportsDryRun: false,
        supportsSchedule: true,
      });
      expect(() => createActionPayload(
        getFeatureById(id),
        {
          tweetUrl: 'https://x.com/source/status/1234567890',
          text: '返信本文',
        },
        'dryRun'
      )).toThrow('確認のみ');
    }

    const reply = createActionPayload(
      getFeatureById('replyToTweet'),
      { tweetUrl: 'https://x.com/source/status/1234567890', text: '返信本文' },
      'live'
    );
    expect(reply).toMatchObject({
      operationType: 'replyToTweet',
      operationConfig: {
        sourceFeatureId: 'replyToTweet',
        tweetUrl: 'https://x.com/source/status/1234567890',
        tweetId: '1234567890',
        textLength: '返信本文'.length,
      },
      jobConfig: {
        tweetUrl: 'https://x.com/source/status/1234567890',
        tweetId: '1234567890',
        text: '返信本文',
      },
    });
    expect(reply.operationConfig.text).toBeUndefined();

    const bookmark = createActionPayload(
      getFeatureById('bookmarkTweet'),
      { tweetUrl: 'https://x.com/source/status/1234567890' },
      'live'
    );
    expect(bookmark.operationType).toBe('bookmarkTweet');
    expect(bookmark.jobConfig.tweetId).toBe('1234567890');

    const deletion = createActionPayload(
      getFeatureById('deleteTweet'),
      { tweetUrl: 'https://x.com/source/status/1234567890' },
      'live'
    );
    expect(deletion.operationType).toBe('deleteTweet');
    expect(deletion.jobConfig.tweetId).toBe('1234567890');
  });

  it('connects utility collection actions without requiring an X account', () => {
    expect(getFeatureById('video')).toMatchObject({
      status: 'available',
      consoleAction: 'extractVideo',
      accountRequired: false,
      supportsSchedule: true,
    });
    expect(getFeatureById('thread')).toMatchObject({
      status: 'available',
      consoleAction: 'unrollThread',
      accountRequired: false,
      supportsSchedule: true,
    });
  });

  it('builds payloads for utility collection actions', () => {
    const video = createActionPayload(
      getFeatureById('video'),
      { tweetUrl: 'https://x.com/user/status/123' },
      'dryRun'
    );
    expect(video).toMatchObject({
      operationType: 'extractVideo',
      operationConfig: {
        sourceFeatureId: 'video',
        tweetUrl: 'https://x.com/user/status/123',
        dryRun: true,
      },
      jobConfig: {
        tweetUrl: 'https://x.com/user/status/123',
        dryRun: true,
      },
    });

    const thread = createActionPayload(
      getFeatureById('thread'),
      { tweetUrl: 'https://x.com/user/status/456', format: 'markdown', maxTweets: 25 },
      'live'
    );
    expect(thread).toMatchObject({
      operationType: 'unrollThread',
      operationConfig: {
        sourceFeatureId: 'thread',
        tweetUrl: 'https://x.com/user/status/456',
        format: 'markdown',
        maxTweets: 25,
        dryRun: true,
      },
      jobConfig: {
        tweetUrl: 'https://x.com/user/status/456',
        format: 'markdown',
        maxTweets: 25,
        dryRun: true,
      },
    });
  });

  it('maps schedule retry settings to queue attempts', () => {
    expect(normalizeScheduleMaxRetries(undefined)).toBe(2);
    expect(normalizeScheduleMaxRetries(0)).toBe(0);
    expect(normalizeScheduleMaxRetries(99)).toBe(5);
    expect(queueAttemptsForSchedule(0)).toBe(1);
    expect(queueAttemptsForSchedule(2)).toBe(3);
  });

  it('exposes sanitized operation details in scheduled run history', () => {
    const run = publicScheduledActionRun({
      id: 'run_1',
      scheduledActionId: 'schedule_1',
      operationId: 'operation_1',
      status: 'completed',
      scheduledFor: new Date('2026-05-21T00:00:00.000Z'),
      startedAt: new Date('2026-05-21T00:00:01.000Z'),
      finishedAt: new Date('2026-05-21T00:00:02.000Z'),
      createdAt: new Date('2026-05-21T00:00:00.000Z'),
      operation: {
        id: 'operation_1',
        type: 'postTweet',
        status: 'completed',
        config: JSON.stringify({
          sourceFeatureId: 'postTweet',
          text: 'secret post body',
          textPreview: 'public preview',
          sessionCookie: 'auth_token=secret',
        }),
        result: JSON.stringify({ dryRun: true, preview: '投稿プレビュー' }),
        error: null,
        account: {
          id: 'acc_1',
          username: 'source_account',
          encryptedCookie: 'encrypted-secret',
          status: 'active',
          isDefault: true,
        },
      },
    });

    expect(run.operationStatus).toBe('completed');
    expect(run.operationType).toBe('postTweet');
    expect(run.account).toMatchObject({ id: 'acc_1', username: 'source_account' });
    expect(run.account.encryptedCookie).toBeUndefined();
    expect(run.result).toEqual({ dryRun: true, preview: '投稿プレビュー' });
    expect(run.operation.config).toMatchObject({
      sourceFeatureId: 'postTweet',
      text: '[hidden]',
      textPreview: '[hidden]',
      sessionCookie: '[hidden]',
    });
  });

  it('blocks reactivating schedules for unavailable accounts', () => {
    expect(() => assertScheduleAccountRunnable({
      accountId: 'acc_1',
      account: { username: 'active_account', status: 'active' },
    })).not.toThrow();
    expect(() => assertScheduleAccountRunnable({ accountId: null })).not.toThrow();
    expect(() => assertScheduleAccountRunnable({
      accountId: 'acc_2',
      account: { username: 'disabled_account', status: 'disabled' },
    })).toThrow('実行できる状態ではありません');
    expect(() => assertScheduleAccountRunnable({
      accountId: 'acc_3',
      account: null,
    })).toThrow('実行できる状態ではありません');
  });

  it('distinguishes retrying jobs from final failures', () => {
    expect(getJobRetryState({ attemptsMade: 1, opts: { attempts: 3 } })).toMatchObject({
      attemptsMade: 1,
      maxAttempts: 3,
      willRetry: true,
      remainingAttempts: 2,
    });

    expect(getJobRetryState({ attemptsMade: 3, opts: { attempts: 3 } })).toMatchObject({
      willRetry: false,
      remainingAttempts: 0,
    });
  });
});
