import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const META_RE_NAME_FIRST = /<meta\s+[^>]*name=["']omochi-kpi-endpoint["'][^>]*content=["']([^"']*)["'][^>]*>/i;
const META_RE_CONTENT_FIRST = /<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']omochi-kpi-endpoint["'][^>]*>/i;

function normalizeEndpointUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.toLowerCase() === 'disabled') {
    return null;
  }
  if (/[\x00-\x1f\x7f\s]/.test(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function resolveKpiEndpoint(repoRoot, env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'OMOCHI_TUNE_KPI_ENDPOINT') && env.OMOCHI_TUNE_KPI_ENDPOINT !== undefined) {
    return normalizeEndpointUrl(env.OMOCHI_TUNE_KPI_ENDPOINT);
  }
  if (!repoRoot) {
    return null;
  }
  try {
    const html = await readFile(join(repoRoot, 'index.html'), 'utf8');
    const match = html.match(META_RE_NAME_FIRST) || html.match(META_RE_CONTENT_FIRST);
    return match ? normalizeEndpointUrl(match[1]) : null;
  } catch {
    return null;
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function computeRates(totals) {
  if (!totals || typeof totals !== 'object') {
    return { tarotExperienceRate: null, bookingDmCtr: null, shareRate: null };
  }
  const lpView = Number(totals.lp_view || 0);
  const tarotDraw = Number(totals.tarot_draw || 0);
  const bookingClick = Number(totals.booking_dm_click || 0);
  const shareClick = Number(totals.tarot_share_click || 0);
  return {
    tarotExperienceRate: lpView > 0 ? round4(tarotDraw / lpView) : null,
    bookingDmCtr: lpView > 0 ? round4(bookingClick / lpView) : null,
    shareRate: tarotDraw > 0 ? round4(shareClick / tarotDraw) : null
  };
}

export async function fetchKpiSummary({
  repoRoot,
  endpoint,
  readToken,
  days = 30,
  fetchImpl = fetch,
  env = process.env
} = {}) {
  const windowDays = Math.max(1, Math.min(365, Math.trunc(Number(days) || 30)));
  const resolvedEndpoint = endpoint !== undefined ? normalizeEndpointUrl(endpoint) : await resolveKpiEndpoint(repoRoot, env);

  if (!resolvedEndpoint) {
    return {
      configured: false,
      status: 'not-measured',
      endpoint: null,
      windowDays,
      allTimeTotal: 0,
      firstEventAt: null,
      lastEventAt: null,
      totals: null,
      rates: null,
      breakdowns: null,
      daily: [],
      note: 'index.html の omochi-kpi-endpoint（または環境変数 OMOCHI_TUNE_KPI_ENDPOINT）が未設定のため未計測です。'
    };
  }

  const summaryUrl = `${resolvedEndpoint}/summary?days=${windowDays}`;
  const token = String(readToken ?? env.OMOCHI_TUNE_KPI_READ_TOKEN ?? '').trim();
  const headers = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetchImpl(summaryUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      throw new Error(`KPI summary HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid KPI summary response payload');
    }
    const allTimeTotal = Number(payload.allTimeTotal ?? 0);
    const status = payload.status || (allTimeTotal > 0 ? 'measuring' : 'ready_no_events');
    const totals = payload.totals ?? null;
    const rates = payload.rates ?? (totals ? computeRates(totals) : null);

    return {
      configured: true,
      endpoint: resolvedEndpoint,
      windowDays: Number(payload.windowDays ?? windowDays),
      allTimeTotal,
      firstEventAt: payload.firstEventAt ?? null,
      lastEventAt: payload.lastEventAt ?? null,
      totals,
      rates,
      breakdowns: payload.breakdowns ?? null,
      daily: Array.isArray(payload.daily) ? payload.daily : [],
      status
    };
  } catch (err) {
    return {
      configured: true,
      status: 'error',
      endpoint: resolvedEndpoint,
      windowDays,
      error: err instanceof Error ? err.message : String(err),
      allTimeTotal: 0,
      firstEventAt: null,
      lastEventAt: null,
      totals: null,
      rates: null,
      breakdowns: null,
      daily: []
    };
  }
}
