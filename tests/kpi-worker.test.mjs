import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerHandler } from '../workers/kpi/src/index.mjs';

function createMockD1() {
  const rows = [];

  function runAggregate(startDate) {
    const filtered = rows.filter((r) => r.event_date_jst >= startDate);
    const count = (pred) => filtered.filter(pred).length;
    return {
      lp_view: count((r) => r.event === 'lp_view'),
      tarot_draw: count((r) => r.event === 'tarot_draw'),
      booking_dm_click: count((r) => r.event === 'booking_dm_click'),
      tarot_share_click: count((r) => r.event === 'tarot_share_click'),
      tarot_daily: count((r) => r.event === 'tarot_draw' && r.mode === 'daily'),
      tarot_love: count((r) => r.event === 'tarot_draw' && r.mode === 'love'),
      booking_hero: count((r) => r.event === 'booking_dm_click' && r.placement === 'hero'),
      booking_instagram_card: count((r) => r.event === 'booking_dm_click' && r.placement === 'instagram_card'),
      booking_sticky_mobile: count((r) => r.event === 'booking_dm_click' && r.placement === 'sticky_mobile'),
      share_x: count((r) => r.event === 'tarot_share_click' && r.channel === 'x'),
      share_line: count((r) => r.event === 'tarot_share_click' && r.channel === 'line'),
      share_copy: count((r) => r.event === 'tarot_share_click' && r.channel === 'copy'),
      share_native: count((r) => r.event === 'tarot_share_click' && r.channel === 'native')
    };
  }

  function runDaily(startDate) {
    const byDate = new Map();
    for (const r of rows) {
      if (r.event_date_jst < startDate) continue;
      if (!byDate.has(r.event_date_jst)) {
        byDate.set(r.event_date_jst, {
          date: r.event_date_jst,
          lp_view: 0,
          tarot_draw: 0,
          booking_dm_click: 0,
          tarot_share_click: 0
        });
      }
      byDate.get(r.event_date_jst)[r.event] += 1;
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    rows,
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      let bound = [];
      const stmt = {
        bind(...args) {
          bound = args;
          return stmt;
        },
        async run() {
          if (normalized.startsWith('INSERT INTO kpi_events')) {
            const [event, mode, placement, channel, eventDateJst, createdAt] = bound;
            rows.push({
              id: rows.length + 1,
              schema_version: 1,
              event,
              page: 'lp',
              mode,
              placement,
              channel,
              event_date_jst: eventDateJst,
              created_at: createdAt
            });
            return { success: true };
          }
          throw new Error(`Unexpected run SQL: ${normalized}`);
        },
        async first() {
          if (normalized.startsWith('SELECT COUNT(*) AS all_time_total FROM kpi_events')) {
            return { all_time_total: rows.length };
          }
          throw new Error(`Unexpected first SQL: ${normalized}`);
        },
        _exec() {
          if (normalized.includes('MIN(created_at)')) {
            return {
              results: [
                {
                  all_time_total: rows.length,
                  first_event_at: rows[0]?.created_at ?? null,
                  last_event_at: rows[rows.length - 1]?.created_at ?? null
                }
              ]
            };
          }
          if (normalized.includes('AS tarot_daily')) {
            return { results: [runAggregate(bound[0])] };
          }
          if (normalized.includes('GROUP BY event_date_jst')) {
            return { results: runDaily(bound[0]) };
          }
          throw new Error(`Unexpected batch SQL: ${normalized}`);
        }
      };
      return stmt;
    },
    async batch(statements) {
      return statements.map((s) => s._exec());
    }
  };
}

test('kpi worker handles CORS, validation, size limit, ingest, summary, and Bearer auth', async () => {
  const db = createMockD1();
  let tick = 0;
  const worker = createWorkerHandler({
    now: () => new Date(Date.UTC(2026, 10, 26, 15, 0, tick++))
  });
  const env = { DB: db };

  // 1. Empty state health & summary
  const healthRes = await worker.fetch(new Request('https://kpi.example/health'), env);
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), {
    ok: true,
    status: 'healthy',
    worker: 'omochi-tune-kpi',
    allTimeTotal: 0
  });

  const emptySummary = await worker.fetch(new Request('https://kpi.example/summary?days=30'), env);
  assert.equal(emptySummary.status, 200);
  const emptyJson = await emptySummary.json();
  assert.equal(emptyJson.status, 'ready_no_events');
  assert.equal(emptyJson.allTimeTotal, 0);
  assert.equal(emptyJson.rates.bookingDmCtr, null);

  // 2. OPTIONS CORS preflight
  const preflightOk = await worker.fetch(
    new Request('https://kpi.example/', {
      method: 'OPTIONS',
      headers: { Origin: 'https://kanta13jp1.github.io' }
    }),
    env
  );
  assert.equal(preflightOk.status, 204);
  assert.equal(preflightOk.headers.get('access-control-allow-origin'), 'https://kanta13jp1.github.io');

  const preflightBad = await worker.fetch(
    new Request('https://kpi.example/', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' }
    }),
    env
  );
  assert.equal(preflightBad.status, 403);

  // 3. Reject disallowed Origin, unknown PII properties, invalid enum, oversized body
  const badOrigin = await worker.fetch(
    new Request('https://kpi.example/', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, event: 'lp_view', page: 'lp' })
    }),
    env
  );
  assert.equal(badOrigin.status, 403);

  const piiReject = await worker.fetch(
    new Request('https://kpi.example/', {
      method: 'POST',
      headers: { Origin: 'https://kanta13jp1.github.io', 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ schemaVersion: 1, event: 'lp_view', page: 'lp', email: 'x@example.com' })
    }),
    env
  );
  assert.equal(piiReject.status, 400);

  const badModeReject = await worker.fetch(
    new Request('https://kpi.example/', {
      method: 'POST',
      headers: { Origin: 'https://kanta13jp1.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, event: 'tarot_draw', page: 'lp', mode: 'evil' })
    }),
    env
  );
  assert.equal(badModeReject.status, 400);

  const oversized = await worker.fetch(
    new Request('https://kpi.example/', {
      method: 'POST',
      headers: { Origin: 'https://kanta13jp1.github.io', 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ schemaVersion: 1, event: 'lp_view', page: 'lp', pad: 'x'.repeat(2200) })
    }),
    env
  );
  assert.equal(oversized.status, 413);

  // 4. Accept valid events via both text/plain (sendBeacon) and application/json (fetch)
  for (const [ct, payload] of [
    ['text/plain;charset=UTF-8', { schemaVersion: 1, event: 'lp_view', page: 'lp', ts: '2026-11-26T15:00:00.000Z' }],
    ['text/plain;charset=UTF-8', { schemaVersion: 1, event: 'lp_view', page: 'lp' }],
    ['application/json', { schemaVersion: 1, event: 'tarot_draw', page: 'lp', mode: 'love' }],
    ['text/plain;charset=UTF-8', { schemaVersion: 1, event: 'booking_dm_click', page: 'lp', placement: 'hero' }],
    ['application/json', { schemaVersion: 1, event: 'tarot_share_click', page: 'lp', channel: 'x' }]
  ]) {
    const res = await worker.fetch(
      new Request('https://kpi.example/', {
        method: 'POST',
        headers: { Origin: 'https://kanta13jp1.github.io', 'Content-Type': ct },
        body: JSON.stringify(payload)
      }),
      env
    );
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://kanta13jp1.github.io');
    const json = await res.json();
    assert.deepEqual(json, { ok: true, accepted: true });
  }

  // 5. Summary metrics & rates
  const liveSummaryRes = await worker.fetch(new Request('https://kpi.example/summary?days=30'), env);
  assert.equal(liveSummaryRes.status, 200);
  const liveSummary = await liveSummaryRes.json();
  assert.equal(liveSummary.status, 'measuring');
  assert.equal(liveSummary.allTimeTotal, 5);
  assert.deepEqual(liveSummary.totals, {
    lp_view: 2,
    tarot_draw: 1,
    booking_dm_click: 1,
    tarot_share_click: 1
  });
  assert.equal(liveSummary.rates.tarotExperienceRate, 0.5);
  assert.equal(liveSummary.rates.bookingDmCtr, 0.5);
  assert.equal(liveSummary.rates.shareRate, 1);
  assert.equal(liveSummary.breakdowns.tarotByMode.love, 1);
  assert.equal(liveSummary.breakdowns.bookingByPlacement.hero, 1);
  assert.equal(liveSummary.breakdowns.shareByChannel.x, 1);
  assert.equal(liveSummary.daily.length, 1);
  assert.equal(liveSummary.daily[0].date, '2026-11-27');

  // 6. Optional Bearer protection on /summary
  const protectedEnv = { DB: db, OMOCHI_KPI_READ_TOKEN: 'secret-token-value' };
  const unauthSummary = await worker.fetch(new Request('https://kpi.example/summary'), protectedEnv);
  assert.equal(unauthSummary.status, 401);

  const authSummary = await worker.fetch(
    new Request('https://kpi.example/summary', {
      headers: { Authorization: 'Bearer secret-token-value' }
    }),
    protectedEnv
  );
  assert.equal(authSummary.status, 200);
});
