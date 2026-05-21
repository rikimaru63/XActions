const DEFAULT_SCHEDULE_MAX_RETRIES = 2;
const MAX_SCHEDULE_RETRIES = 5;

function toInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(numeric);
}

function normalizeScheduleMaxRetries(value, fallback = DEFAULT_SCHEDULE_MAX_RETRIES) {
  const retries = toInteger(value, fallback);
  return Math.min(Math.max(retries, 0), MAX_SCHEDULE_RETRIES);
}

function queueAttemptsForSchedule(maxRetries) {
  return normalizeScheduleMaxRetries(maxRetries) + 1;
}

function getJobRetryState(job = {}) {
  const attemptsMade = Math.max(toInteger(job.attemptsMade, 0), 0);
  const maxAttempts = Math.max(toInteger(job.opts?.attempts, 1), 1);

  return {
    attemptsMade,
    maxAttempts,
    willRetry: attemptsMade < maxAttempts,
    remainingAttempts: Math.max(maxAttempts - attemptsMade, 0),
  };
}

export {
  DEFAULT_SCHEDULE_MAX_RETRIES,
  MAX_SCHEDULE_RETRIES,
  getJobRetryState,
  normalizeScheduleMaxRetries,
  queueAttemptsForSchedule,
};
