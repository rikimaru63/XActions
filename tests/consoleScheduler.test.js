import { describe, expect, it } from 'vitest';
import { getFeatureById, getPublicFeatureCatalog } from '../api/config/features.js';
import { shouldSerializeAccountJob } from '../api/services/accountExecutionLock.js';
import { createActionPayload } from '../api/services/consoleActions.js';
import { summarizeChildStatuses } from '../api/services/operationBatches.js';
import { calculateNextRunAt } from '../api/services/scheduleUtils.js';

describe('console scheduler helpers', () => {
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
    const payload = createActionPayload(
      getFeatureById('sendDM'),
      { username: '@target_user', message: 'hello' },
      'dryRun'
    );

    expect(payload.operationType).toBe('targetEngage');
    expect(payload.operationConfig).toMatchObject({
      sourceFeatureId: 'sendDM',
      targetUsername: 'target_user',
      hasDmMessage: true,
    });
    expect(payload.operationConfig.dmMessage).toBeUndefined();
    expect(payload.jobConfig.dmMessage).toBe('hello');
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
});
