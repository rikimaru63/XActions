const JST_OFFSET = '+09:00';

function parseRunAt(value, timezone = 'Asia/Tokyo') {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const withSeconds = raw.length === 16 ? `${raw}:00` : raw;
  const offset = timezone === 'Asia/Tokyo' ? JST_OFFSET : '';
  const date = new Date(`${withSeconds}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function nextDaily(runAt, from) {
  const base = runAt || from;
  let candidate = new Date(from);
  candidate.setUTCHours(base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), 0);
  while (candidate <= from) candidate = addDays(candidate, 1);
  return candidate;
}

function parseDaysOfWeek(daysOfWeek, fallbackDate) {
  const days = String(daysOfWeek || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  if (days.length) return days;
  return [fallbackDate.getUTCDay()];
}

function nextWeekly(runAt, daysOfWeek, from) {
  const base = runAt || from;
  const days = parseDaysOfWeek(daysOfWeek, base);

  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = addDays(new Date(from), offset);
    candidate.setUTCHours(base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), 0);
    if (candidate > from && days.includes(candidate.getUTCDay())) return candidate;
  }

  return addDays(from, 7);
}

function parseCronField(field, min, max) {
  const values = new Set();
  const text = String(field || '*').trim();
  if (text === '*') {
    for (let value = min; value <= max; value += 1) values.add(value);
    return values;
  }

  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;

    if (token.startsWith('*/')) {
      const step = Number(token.slice(2));
      if (!Number.isInteger(step) || step <= 0) throw new Error('cron の間隔指定が正しくありません。');
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }

    if (token.includes('-')) {
      const [start, end] = token.split('-').map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error('cron の範囲指定が正しくありません。');
      }
      for (let value = start; value <= end; value += 1) values.add(value);
      continue;
    }

    const number = Number(token);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error('cron の値が正しくありません。');
    }
    values.add(number);
  }

  if (!values.size) throw new Error('cron の値が空です。');
  return values;
}

function parseCron(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron は5フィールドで入力してください。');
  return {
    minutes: parseCronField(parts[0], 0, 59),
    hours: parseCronField(parts[1], 0, 23),
    days: parseCronField(parts[2], 1, 31),
    months: parseCronField(parts[3], 1, 12),
    weekdays: parseCronField(parts[4], 0, 6),
  };
}

function matchesCron(date, cron) {
  return cron.minutes.has(date.getUTCMinutes())
    && cron.hours.has(date.getUTCHours())
    && cron.days.has(date.getUTCDate())
    && cron.months.has(date.getUTCMonth() + 1)
    && cron.weekdays.has(date.getUTCDay());
}

function nextCronRun(cronText, from) {
  const cron = parseCron(cronText);
  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  let candidate = addMinutes(start, 1);
  const maxMinutes = 366 * 24 * 60;

  for (let index = 0; index < maxMinutes; index += 1) {
    if (matchesCron(candidate, cron)) return candidate;
    candidate = addMinutes(candidate, 1);
  }

  throw new Error('次回実行日時を1年以内に計算できませんでした。');
}

function calculateNextRunAt(schedule, from = new Date()) {
  const type = schedule.scheduleType || schedule.type;
  const timezone = schedule.timezone || 'Asia/Tokyo';
  const runAt = parseRunAt(schedule.runAt, timezone);

  if (type === 'once') {
    if (!runAt) throw new Error('実行日時を入力してください。');
    return runAt;
  }

  if (type === 'daily') {
    return nextDaily(runAt, from);
  }

  if (type === 'weekly') {
    return nextWeekly(runAt, schedule.daysOfWeek, from);
  }

  if (type === 'interval') {
    const intervalMinutes = Math.max(Number(schedule.intervalMinutes) || 0, 1);
    if (runAt && runAt > from) return runAt;
    return addMinutes(from, intervalMinutes);
  }

  if (type === 'cron') {
    return nextCronRun(schedule.cron, from);
  }

  throw new Error('予約タイプが正しくありません。');
}

function normalizeScheduleInput(schedule = {}) {
  const type = schedule.type || schedule.scheduleType || 'once';
  const timezone = schedule.timezone || 'Asia/Tokyo';
  const runAt = parseRunAt(schedule.runAt, timezone);
  const intervalMinutes = schedule.intervalMinutes ? Math.max(Number(schedule.intervalMinutes) || 0, 1) : null;

  return {
    scheduleType: type,
    cron: schedule.cron ? String(schedule.cron).trim() : null,
    intervalMinutes,
    runAt,
    daysOfWeek: schedule.daysOfWeek ? String(schedule.daysOfWeek) : null,
    timezone,
  };
}

export {
  calculateNextRunAt,
  normalizeScheduleInput,
  parseCron,
  parseRunAt,
};
