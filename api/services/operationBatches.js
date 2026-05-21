import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

function summarizeChildStatuses(children = []) {
  const counts = {
    total: children.length,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const child of children) {
    const status = child?.status || 'pending';
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    } else {
      counts.pending += 1;
    }
  }

  const terminal = counts.total > 0
    && children.every((child) => terminalStatuses.has(child?.status));

  let status = 'pending';
  if (counts.processing > 0) status = 'processing';
  else if (terminal && counts.failed > 0) status = 'failed';
  else if (terminal && counts.cancelled === counts.total) status = 'cancelled';
  else if (terminal && counts.completed === counts.total) status = 'completed';
  else if (counts.completed > 0 || counts.failed > 0 || counts.cancelled > 0) status = 'processing';

  return {
    counts,
    status,
    terminal,
    error: counts.failed > 0 ? `${counts.failed}件のアカウントで失敗しました。` : null,
  };
}

async function refreshParentOperation(parentOperationId) {
  if (!parentOperationId) return null;

  const parent = await prisma.operation.findUnique({
    where: { id: parentOperationId },
    include: {
      childOperations: {
        select: {
          id: true,
          status: true,
        },
      },
    },
  });

  if (!parent || !parent.childOperations.length) return parent;

  const summary = summarizeChildStatuses(parent.childOperations);
  const now = new Date();
  const data = {
    status: summary.status,
    result: JSON.stringify({
      batch: true,
      ...summary.counts,
    }),
    error: summary.error,
  };

  if (summary.status === 'processing' && !parent.startedAt) {
    data.startedAt = now;
  }

  if (summary.terminal && !parent.completedAt) {
    data.completedAt = now;
  }

  return prisma.operation.update({
    where: { id: parent.id },
    data,
  });
}

async function refreshParentOperationByChild(childOperationId) {
  if (!childOperationId) return null;

  const child = await prisma.operation.findUnique({
    where: { id: childOperationId },
    select: { parentOperationId: true },
  });

  return refreshParentOperation(child?.parentOperationId);
}

export {
  refreshParentOperation,
  refreshParentOperationByChild,
  summarizeChildStatuses,
};
