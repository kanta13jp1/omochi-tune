const ALLOWED_ORIGINS = new Set(['https://kanta13jp1.github.io']);
const ALLOWED_MODES = new Set(['daily', 'love']);
const ALLOWED_PLACEMENTS = new Set(['hero', 'instagram_card', 'sticky_mobile']);
const ALLOWED_CHANNELS = new Set(['x', 'line', 'copy', 'native']);
const MAX_BODY_BYTES = 2048;

function toJstDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getJstStartDate(nowDate, windowDays) {
  const start = new Date(nowDate.getTime() - (windowDays - 1) * 86400000);
  return toJstDateString(start);
}

function clampDays(raw) {
  if (raw === null || raw === undefined || raw === '') return 30;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(parsed)));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function corsHeadersFor(origin, { preflight = false } = {}) {
  const headers = {
    Vary: 'Origin'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (preflight) {
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Max-Age'] = '86400';
    }
  }
  return headers;
}

function jsonResponse(body, { status = 200, origin = null } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeadersFor(origin)
    }
  });
}

async function readBoundedText(request, maxBytes) {
  const contentLenHeader = request.headers.get('content-length');
  if (contentLenHeader !== null) {
    const contentLen = Number(contentLenHeader);
    if (Number.isFinite(contentLen) && contentLen > maxBytes) {
      return { tooLarge: true, text: '' };
    }
  }
  if (!request.body) {
    return { tooLarge: false, text: '' };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true, text: '' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(combined) };
}

function validateEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'invalid_json_object' };
  }
  if (payload.schemaVersion !== 1 || payload.page !== 'lp') {
    return { ok: false, error: 'invalid_schema_or_page' };
  }
  if (payload.ts !== undefined) {
    if (typeof payload.ts !== 'string' || payload.ts.length > 40 || Number.isNaN(Date.parse(payload.ts))) {
      return { ok: false, error: 'invalid_timestamp' };
    }
  }

  const keys = Object.keys(payload);
  const event = payload.event;
  let allowedKeys;
  let mode = null;
  let placement = null;
  let channel = null;

  if (event === 'lp_view') {
    allowedKeys = new Set(['schemaVersion', 'event', 'page', 'ts']);
  } else if (event === 'tarot_draw') {
    if (typeof payload.mode !== 'string' || !ALLOWED_MODES.has(payload.mode)) {
      return { ok: false, error: 'invalid_mode' };
    }
    mode = payload.mode;
    allowedKeys = new Set(['schemaVersion', 'event', 'page', 'mode', 'ts']);
  } else if (event === 'booking_dm_click') {
    if (typeof payload.placement !== 'string' || !ALLOWED_PLACEMENTS.has(payload.placement)) {
      return { ok: false, error: 'invalid_placement' };
    }
    placement = payload.placement;
    allowedKeys = new Set(['schemaVersion', 'event', 'page', 'placement', 'ts']);
  } else if (event === 'tarot_share_click') {
    if (typeof payload.channel !== 'string' || !ALLOWED_CHANNELS.has(payload.channel)) {
      return { ok: false, error: 'invalid_channel' };
    }
    channel = payload.channel;
    allowedKeys = new Set(['schemaVersion', 'event', 'page', 'channel', 'ts']);
  } else {
    return { ok: false, error: 'unknown_event' };
  }

  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: 'unexpected_property' };
    }
  }

  return { ok: true, event, mode, placement, channel };
}

async function verifyBearerToken(authHeader, expectedToken) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const provided = authHeader.slice('Bearer '.length).trim();
  if (!provided) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedToken))
  ]);
  if (typeof crypto?.subtle?.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }
  const a = new Uint8Array(providedHash);
  const b = new Uint8Array(expectedHash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function handleHealth(env, origin) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS all_time_total FROM kpi_events').first();
  const allTimeTotal = Number(row?.all_time_total ?? 0);
  return jsonResponse(
    {
      ok: true,
      status: 'healthy',
      worker: 'omochi-tune-kpi',
      allTimeTotal
    },
    { status: 200, origin }
  );
}

async function handleSummary(request, url, env, origin, nowDate) {
  const expectedToken = typeof env.OMOCHI_KPI_READ_TOKEN === 'string' ? env.OMOCHI_KPI_READ_TOKEN.trim() : '';
  if (expectedToken) {
    const valid = await verifyBearerToken(request.headers.get('authorization'), expectedToken);
    if (!valid) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, { status: 401, origin });
    }
  }

  const windowDays = clampDays(url.searchParams.get('days'));
  const startDateJst = getJstStartDate(nowDate, windowDays);

  const [allTimeRes, totalsRes, dailyRes] = await env.DB.batch([
    env.DB.prepare(
      'SELECT COUNT(*) AS all_time_total, MIN(created_at) AS first_event_at, MAX(created_at) AS last_event_at FROM kpi_events'
    ),
    env.DB.prepare(
      `SELECT
        SUM(CASE WHEN event = 'lp_view' THEN 1 ELSE 0 END) AS lp_view,
        SUM(CASE WHEN event = 'tarot_draw' THEN 1 ELSE 0 END) AS tarot_draw,
        SUM(CASE WHEN event = 'booking_dm_click' THEN 1 ELSE 0 END) AS booking_dm_click,
        SUM(CASE WHEN event = 'tarot_share_click' THEN 1 ELSE 0 END) AS tarot_share_click,
        SUM(CASE WHEN event = 'tarot_draw' AND mode = 'daily' THEN 1 ELSE 0 END) AS tarot_daily,
        SUM(CASE WHEN event = 'tarot_draw' AND mode = 'love' THEN 1 ELSE 0 END) AS tarot_love,
        SUM(CASE WHEN event = 'booking_dm_click' AND placement = 'hero' THEN 1 ELSE 0 END) AS booking_hero,
        SUM(CASE WHEN event = 'booking_dm_click' AND placement = 'instagram_card' THEN 1 ELSE 0 END) AS booking_instagram_card,
        SUM(CASE WHEN event = 'booking_dm_click' AND placement = 'sticky_mobile' THEN 1 ELSE 0 END) AS booking_sticky_mobile,
        SUM(CASE WHEN event = 'tarot_share_click' AND channel = 'x' THEN 1 ELSE 0 END) AS share_x,
        SUM(CASE WHEN event = 'tarot_share_click' AND channel = 'line' THEN 1 ELSE 0 END) AS share_line,
        SUM(CASE WHEN event = 'tarot_share_click' AND channel = 'copy' THEN 1 ELSE 0 END) AS share_copy,
        SUM(CASE WHEN event = 'tarot_share_click' AND channel = 'native' THEN 1 ELSE 0 END) AS share_native
      FROM kpi_events
      WHERE event_date_jst >= ?`
    ).bind(startDateJst),
    env.DB.prepare(
      `SELECT
        event_date_jst AS date,
        SUM(CASE WHEN event = 'lp_view' THEN 1 ELSE 0 END) AS lp_view,
        SUM(CASE WHEN event = 'tarot_draw' THEN 1 ELSE 0 END) AS tarot_draw,
        SUM(CASE WHEN event = 'booking_dm_click' THEN 1 ELSE 0 END) AS booking_dm_click,
        SUM(CASE WHEN event = 'tarot_share_click' THEN 1 ELSE 0 END) AS tarot_share_click
      FROM kpi_events
      WHERE event_date_jst >= ?
      GROUP BY event_date_jst
      ORDER BY event_date_jst ASC`
    ).bind(startDateJst)
  ]);

  const allTimeRow = allTimeRes.results?.[0] || {};
  const agg = totalsRes.results?.[0] || {};
  const allTimeTotal = Number(allTimeRow.all_time_total ?? 0);

  const totals = {
    lp_view: Number(agg.lp_view ?? 0),
    tarot_draw: Number(agg.tarot_draw ?? 0),
    booking_dm_click: Number(agg.booking_dm_click ?? 0),
    tarot_share_click: Number(agg.tarot_share_click ?? 0)
  };

  const rates = {
    tarotExperienceRate: totals.lp_view > 0 ? round4(totals.tarot_draw / totals.lp_view) : null,
    bookingDmCtr: totals.lp_view > 0 ? round4(totals.booking_dm_click / totals.lp_view) : null,
    shareRate: totals.tarot_draw > 0 ? round4(totals.tarot_share_click / totals.tarot_draw) : null
  };

  const breakdowns = {
    tarotByMode: {
      daily: Number(agg.tarot_daily ?? 0),
      love: Number(agg.tarot_love ?? 0)
    },
    bookingByPlacement: {
      hero: Number(agg.booking_hero ?? 0),
      instagram_card: Number(agg.booking_instagram_card ?? 0),
      sticky_mobile: Number(agg.booking_sticky_mobile ?? 0)
    },
    shareByChannel: {
      x: Number(agg.share_x ?? 0),
      line: Number(agg.share_line ?? 0),
      copy: Number(agg.share_copy ?? 0),
      native: Number(agg.share_native ?? 0)
    }
  };

  const daily = (dailyRes.results || []).map((row) => ({
    date: row.date,
    lp_view: Number(row.lp_view ?? 0),
    tarot_draw: Number(row.tarot_draw ?? 0),
    booking_dm_click: Number(row.booking_dm_click ?? 0),
    tarot_share_click: Number(row.tarot_share_click ?? 0)
  }));

  return jsonResponse(
    {
      ok: true,
      status: allTimeTotal > 0 ? 'measuring' : 'ready_no_events',
      windowDays,
      allTimeTotal,
      firstEventAt: allTimeRow.first_event_at ?? null,
      lastEventAt: allTimeRow.last_event_at ?? null,
      totals,
      rates,
      breakdowns,
      daily
    },
    { status: 200, origin }
  );
}

async function handleIngest(request, env, origin, nowDate) {
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse({ ok: false, error: 'origin_not_allowed' }, { status: 403, origin: null });
  }

  const contentType = (request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (contentType && contentType !== 'application/json' && contentType !== 'text/plain') {
    return jsonResponse({ ok: false, error: 'unsupported_content_type' }, { status: 400, origin });
  }

  const { tooLarge, text } = await readBoundedText(request, MAX_BODY_BYTES);
  if (tooLarge) {
    return jsonResponse({ ok: false, error: 'payload_too_large' }, { status: 413, origin });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'malformed_json' }, { status: 400, origin });
  }

  const checked = validateEventPayload(parsed);
  if (!checked.ok) {
    return jsonResponse({ ok: false, error: checked.error }, { status: 400, origin });
  }

  const eventDateJst = toJstDateString(nowDate);
  const createdAt = nowDate.toISOString();

  await env.DB.prepare(
    `INSERT INTO kpi_events (schema_version, event, page, mode, placement, channel, event_date_jst, created_at)
     VALUES (1, ?, 'lp', ?, ?, ?, ?, ?)`
  )
    .bind(checked.event, checked.mode, checked.placement, checked.channel, eventDateJst, createdAt)
    .run();

  console.log(
    JSON.stringify({
      message: 'kpi_event_accepted',
      event: checked.event,
      eventDateJst
    })
  );

  return jsonResponse({ ok: true, accepted: true }, { status: 202, origin });
}

export function createWorkerHandler({ now = () => new Date() } = {}) {
  return {
    async fetch(request, env) {
      const origin = request.headers.get('origin');
      try {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = request.method.toUpperCase();

        if (method === 'OPTIONS') {
          if (origin && !ALLOWED_ORIGINS.has(origin)) {
            return new Response(null, { status: 403 });
          }
          return new Response(null, {
            status: 204,
            headers: corsHeadersFor(origin, { preflight: true })
          });
        }

        if (method === 'GET' && path === '/health') {
          return await handleHealth(env, origin);
        }

        if (method === 'GET' && (path === '/summary' || path === '/')) {
          return await handleSummary(request, url, env, origin, now());
        }

        if (method === 'POST' && (path === '/' || path === '/event')) {
          return await handleIngest(request, env, origin, now());
        }

        if ((path === '/' || path === '/event' || path === '/health' || path === '/summary') && method !== 'GET' && method !== 'POST') {
          return jsonResponse({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
        }

        return jsonResponse({ ok: false, error: 'not_found' }, { status: 404, origin });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ message: 'kpi_worker_error', error: message }));
        return jsonResponse({ ok: false, error: 'internal_error' }, { status: 500, origin });
      }
    }
  };
}

export default createWorkerHandler();
