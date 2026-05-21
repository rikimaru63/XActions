-- Console, scheduled actions, and multi-account support.
-- This migration is intentionally additive because the project did not
-- previously keep Prisma migrations in git.

CREATE TABLE "XAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "displayName" TEXT,
  "avatarUrl" TEXT,
  "encryptedCookie" TEXT NOT NULL,
  "authMethod" TEXT NOT NULL DEFAULT 'session',
  "status" TEXT NOT NULL DEFAULT 'active',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "lastVerifiedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "XAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledAction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accountId" TEXT,
  "name" TEXT NOT NULL,
  "featureId" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "config" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'dryRun',
  "scheduleType" TEXT NOT NULL,
  "cron" TEXT,
  "intervalMinutes" INTEGER,
  "runAt" TIMESTAMP(3),
  "daysOfWeek" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  "status" TEXT NOT NULL DEFAULT 'active',
  "nextRunAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "maxRetries" INTEGER NOT NULL DEFAULT 2,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ScheduledAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledActionRun" (
  "id" TEXT NOT NULL,
  "scheduledActionId" TEXT NOT NULL,
  "operationId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ScheduledActionRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Operation" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Operation" ADD COLUMN "scheduledActionId" TEXT;
ALTER TABLE "Operation" ADD COLUMN "parentOperationId" TEXT;
ALTER TABLE "Operation" ADD COLUMN "batchId" TEXT;

CREATE UNIQUE INDEX "XAccount_userId_username_key" ON "XAccount"("userId", "username");
CREATE INDEX "XAccount_userId_status_idx" ON "XAccount"("userId", "status");
CREATE INDEX "XAccount_userId_isDefault_idx" ON "XAccount"("userId", "isDefault");

CREATE INDEX "ScheduledAction_userId_status_idx" ON "ScheduledAction"("userId", "status");
CREATE INDEX "ScheduledAction_status_nextRunAt_idx" ON "ScheduledAction"("status", "nextRunAt");
CREATE INDEX "ScheduledAction_accountId_idx" ON "ScheduledAction"("accountId");

CREATE INDEX "ScheduledActionRun_scheduledActionId_createdAt_idx" ON "ScheduledActionRun"("scheduledActionId", "createdAt");
CREATE INDEX "ScheduledActionRun_status_scheduledFor_idx" ON "ScheduledActionRun"("status", "scheduledFor");
CREATE INDEX "ScheduledActionRun_operationId_idx" ON "ScheduledActionRun"("operationId");

CREATE INDEX "Operation_accountId_idx" ON "Operation"("accountId");
CREATE INDEX "Operation_scheduledActionId_idx" ON "Operation"("scheduledActionId");
CREATE INDEX "Operation_parentOperationId_idx" ON "Operation"("parentOperationId");
CREATE INDEX "Operation_batchId_idx" ON "Operation"("batchId");

ALTER TABLE "XAccount"
  ADD CONSTRAINT "XAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledAction"
  ADD CONSTRAINT "ScheduledAction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledAction"
  ADD CONSTRAINT "ScheduledAction_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "XAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduledActionRun"
  ADD CONSTRAINT "ScheduledActionRun_scheduledActionId_fkey"
  FOREIGN KEY ("scheduledActionId") REFERENCES "ScheduledAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduledActionRun"
  ADD CONSTRAINT "ScheduledActionRun_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Operation"
  ADD CONSTRAINT "Operation_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "XAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Operation"
  ADD CONSTRAINT "Operation_scheduledActionId_fkey"
  FOREIGN KEY ("scheduledActionId") REFERENCES "ScheduledAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Operation"
  ADD CONSTRAINT "Operation_parentOperationId_fkey"
  FOREIGN KEY ("parentOperationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
