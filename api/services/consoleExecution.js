import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { queueJob } from './jobQueue.js';
import { buildEncryptedRetryConfig } from './consoleRetryConfig.js';

const prisma = new PrismaClient();

async function queueConsoleOperations({ user, feature, payload, accountIds, mode, retryOf = null, retryConfig = null }) {
  const batchId = accountIds.length > 1 || retryOf ? randomUUID() : null;
  let parentOperation = null;
  const encryptedRetryConfig = retryConfig ? buildEncryptedRetryConfig(retryConfig) : {};

  if (batchId) {
    parentOperation = await prisma.operation.create({
      data: {
        userId: user.id,
        batchId,
        type: payload.operationType,
        status: 'pending',
        config: JSON.stringify({
          ...payload.operationConfig,
          sourceFeatureId: feature.id,
          isBatch: true,
          retryOf,
          mode,
          ...encryptedRetryConfig,
          accountIds: accountIds.filter(Boolean),
          childCount: accountIds.length,
        }),
      },
    });
  }

  const operations = [];
  for (const accountId of accountIds) {
    const operation = await prisma.operation.create({
      data: {
        userId: user.id,
        accountId,
        parentOperationId: parentOperation?.id || null,
        batchId,
        type: payload.operationType,
        status: 'pending',
        config: JSON.stringify(payload.operationConfig),
      },
    });

    await queueJob({
      type: payload.operationType,
      operationId: operation.id,
      userId: user.id,
      accountId,
      authMethod: 'session',
      config: payload.jobConfig,
    });

    operations.push({
      operationId: operation.id,
      accountId,
    });
  }

  return {
    operationId: parentOperation?.id || operations[0]?.operationId || null,
    parentOperationId: parentOperation?.id || null,
    operations,
    batchId,
  };
}

export { queueConsoleOperations };
