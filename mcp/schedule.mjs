const VENUE_NAME = '道玄坂教会 天井裏 “M”';
const VENUE_ADDRESS = '東京都渋谷区道玄坂2-16-5 セントラル共立ビル 2F';
const EVENT_TIMEZONE = 'Asia/Tokyo';
const OPEN_HOUR = 20;
const CLOSE_HOUR = 23;

function pad2(num) {
  return String(num).padStart(2, '0');
}

/**
 * Extracts JST calendar & clock parts from a Date without depending on OS timezone.
 * Matches index.html's `getTokyoNow`.
 */
export function getTokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = Number(part.value);
      return acc;
    }, {});

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

/**
 * Computes the first Thursday of a given year and 0-based month (0 = Jan .. 11 = Dec).
 */
export function getFirstThursdayOfMonth(year, monthIndex0) {
  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    throw new Error(`年が不正です: ${year}`);
  }
  if (!Number.isInteger(monthIndex0) || monthIndex0 < 0 || monthIndex0 > 11) {
    throw new Error(`月インデックスが不正です: ${monthIndex0}`);
  }

  const firstDayOfWeek = new Date(Date.UTC(year, monthIndex0, 1)).getUTCDay();
  const dayOffset = (4 - firstDayOfWeek + 7) % 7;
  const day = 1 + dayOffset;
  const month = monthIndex0 + 1;
  const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;

  return {
    year,
    month,
    day,
    dateStr,
    displayDate: `${year}年${month}月${day}日（木）`,
    startTime: `${pad2(OPEN_HOUR)}:00`,
    endTime: `${pad2(CLOSE_HOUR)}:00`,
    startIso: `${dateStr}T${pad2(OPEN_HOUR)}:00:00+09:00`,
    endIso: `${dateStr}T${pad2(CLOSE_HOUR)}:00:00+09:00`,
    timezone: EVENT_TIMEZONE,
    venue: `${VENUE_NAME}（渋谷）`,
    address: VENUE_ADDRESS
  };
}

function parseIsoDateParts(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!match) {
    throw new Error('fromDate は YYYY-MM-DD 形式で指定してください');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`存在しない日付です: ${dateStr}`);
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function toJstEpochMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour - 9, parts.minute, parts.second);
}

/**
 * Computes upcoming First-Thursday event occurrences and live status.
 */
export function getEventSchedule({ count = 6, fromDate, now = new Date() } = {}) {
  const normalizedCount = Number.isInteger(count) ? count : Number(count ?? 6);
  if (!Number.isInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > 12) {
    throw new Error('count は 1〜12 の整数で指定してください');
  }

  const realNowParts = getTokyoParts(now);
  const anchorParts = fromDate ? parseIsoDateParts(fromDate) : realNowParts;

  let y = anchorParts.year;
  let m0 = anchorParts.month - 1;
  let first = getFirstThursdayOfMonth(y, m0);

  // Match index.html rollover rule: after 23:00 JST on the first Thursday, roll to next month.
  const anchorMs = toJstEpochMs(anchorParts);
  const firstEndMs = toJstEpochMs({ year: first.year, month: first.month, day: first.day, hour: CLOSE_HOUR, minute: 0, second: 0 });
  if (anchorMs >= firstEndMs) {
    m0 += 1;
    if (m0 > 11) {
      m0 = 0;
      y += 1;
    }
    first = getFirstThursdayOfMonth(y, m0);
  }

  const upcoming = [first];
  let curY = first.year;
  let curM0 = first.month - 1;
  for (let i = 1; i < normalizedCount; i += 1) {
    curM0 += 1;
    if (curM0 > 11) {
      curM0 = 0;
      curY += 1;
    }
    upcoming.push(getFirstThursdayOfMonth(curY, curM0));
  }

  const nextEvent = upcoming[0];
  const realTodayStr = `${realNowParts.year}-${pad2(realNowParts.month)}-${pad2(realNowParts.day)}`;
  const isToday = realTodayStr === nextEvent.dateStr;
  const isLiveNow = isToday && realNowParts.hour >= OPEN_HOUR && realNowParts.hour < CLOSE_HOUR;
  const isOpeningToday = isToday && realNowParts.hour < OPEN_HOUR;

  let statusLabel = `次回 ${nextEvent.displayDate}`;
  if (isLiveNow) {
    statusLabel = '● 本日 20:00〜23:00 開催中！';
  } else if (isOpeningToday) {
    statusLabel = '本日 20:00 OPEN!';
  }

  const anchorMidnightUtc = Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day);
  const nextMidnightUtc = Date.UTC(nextEvent.year, nextEvent.month - 1, nextEvent.day);
  const daysUntilNext = Math.round((nextMidnightUtc - anchorMidnightUtc) / 86400000);

  return {
    timezone: EVENT_TIMEZONE,
    anchorDate: `${anchorParts.year}-${pad2(anchorParts.month)}-${pad2(anchorParts.day)}`,
    tokyoNow: `${realTodayStr}T${pad2(realNowParts.hour)}:${pad2(realNowParts.minute)}:${pad2(realNowParts.second)}+09:00`,
    isToday,
    isLiveNow,
    statusLabel,
    daysUntilNext,
    nextEvent,
    upcoming
  };
}
