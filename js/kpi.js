(function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var BOOKING_DEBOUNCE_MS = 1500;
  var SHARE_DEBOUNCE_MS = 1500;
  var TAROT_DEBOUNCE_MS = 800;

  var ALLOWED_MODES = { daily: true, love: true };
  var ALLOWED_PLACEMENTS = { hero: true, instagram_card: true, sticky_mobile: true };
  var ALLOWED_CHANNELS = { x: true, line: true, copy: true, native: true };

  var events = [];
  var stats = {
    total: 0,
    sent: 0,
    failed: 0,
    skippedUnconfigured: 0,
    deduplicated: 0
  };

  var lpViewed = false;
  var tarotDrawnSinceReset = false;
  var lastTarotAt = 0;
  var lastPlacementAt = {};
  var lastChannelAt = {};

  function isLocalHost() {
    try {
      var host = (window.location && window.location.hostname) || '';
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';
    } catch (_) {
      return false;
    }
  }

  function getEndpoint() {
    try {
      var cfg = window.__OMOCHI_KPI_CONFIG__;
      if (cfg && typeof cfg.endpoint === 'string') {
        return cfg.endpoint.trim();
      }
      if (isLocalHost()) {
        return '';
      }
      var meta = document.querySelector('meta[name="omochi-kpi-endpoint"]');
      if (meta && typeof meta.content === 'string') {
        return meta.content.trim();
      }
    } catch (_) {
      return '';
    }
    return '';
  }

  function isAllowedEndpoint(url) {
    if (!url) return false;
    if (/[\x00-\x1f\x7f\s]/.test(url)) return false;
    if (url.charAt(0) === '/' && url.charAt(1) !== '/') {
      return true;
    }
    try {
      var parsed = new URL(url, window.location.href);
      return parsed.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function emitCustomEvent(payload, delivery) {
    try {
      if (typeof window.CustomEvent === 'function') {
        window.dispatchEvent(
          new window.CustomEvent('omochi:kpi', {
            detail: { payload: payload, delivery: delivery }
          })
        );
      }
    } catch (_) {
      // Fail-open: never affect UX
    }
  }

  function sendPayload(payload) {
    var endpoint = getEndpoint();
    if (!endpoint) {
      stats.skippedUnconfigured += 1;
      emitCustomEvent(payload, 'skipped_unconfigured');
      return 'skipped_unconfigured';
    }
    if (!isAllowedEndpoint(endpoint)) {
      stats.failed += 1;
      emitCustomEvent(payload, 'invalid_endpoint');
      return 'invalid_endpoint';
    }

    var jsonBody;
    try {
      jsonBody = JSON.stringify(payload);
    } catch (_) {
      stats.failed += 1;
      return 'failed';
    }

    var beaconSent = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        var blob = new Blob([jsonBody], { type: 'text/plain;charset=UTF-8' });
        beaconSent = Boolean(navigator.sendBeacon(endpoint, blob));
      }
    } catch (_) {
      beaconSent = false;
    }

    if (beaconSent) {
      stats.sent += 1;
      emitCustomEvent(payload, 'beacon');
      return 'beacon';
    }

    try {
      if (typeof fetch === 'function') {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: jsonBody,
          keepalive: true,
          credentials: 'omit'
        })
          .then(function (resp) {
            if (resp && resp.ok) {
              stats.sent += 1;
              emitCustomEvent(payload, 'fetch');
            } else {
              stats.failed += 1;
              emitCustomEvent(payload, 'failed');
            }
          })
          .catch(function () {
            stats.failed += 1;
            emitCustomEvent(payload, 'failed');
          });
        return 'fetch_pending';
      }
    } catch (_) {
      // Fall through to failed count
    }

    stats.failed += 1;
    emitCustomEvent(payload, 'failed');
    return 'failed';
  }

  function buildCleanPayload(eventName, props) {
    var nowMs = Date.now();
    var p = props && typeof props === 'object' ? props : {};

    if (eventName === 'lp_view') {
      if (lpViewed) return null;
      lpViewed = true;
      return {
        schemaVersion: SCHEMA_VERSION,
        event: 'lp_view',
        page: 'lp',
        ts: new Date(nowMs).toISOString()
      };
    }

    if (eventName === 'tarot_draw') {
      if (tarotDrawnSinceReset || nowMs - lastTarotAt < TAROT_DEBOUNCE_MS) {
        return null;
      }
      var mode = ALLOWED_MODES[p.mode] ? p.mode : 'daily';
      tarotDrawnSinceReset = true;
      lastTarotAt = nowMs;
      return {
        schemaVersion: SCHEMA_VERSION,
        event: 'tarot_draw',
        page: 'lp',
        mode: mode,
        ts: new Date(nowMs).toISOString()
      };
    }

    if (eventName === 'booking_dm_click') {
      var placement = ALLOWED_PLACEMENTS[p.placement] ? p.placement : '';
      if (!placement) return undefined;
      var prevBooking = lastPlacementAt[placement] || 0;
      if (nowMs - prevBooking < BOOKING_DEBOUNCE_MS) return null;
      lastPlacementAt[placement] = nowMs;
      return {
        schemaVersion: SCHEMA_VERSION,
        event: 'booking_dm_click',
        page: 'lp',
        placement: placement,
        ts: new Date(nowMs).toISOString()
      };
    }

    if (eventName === 'tarot_share_click') {
      var channel = ALLOWED_CHANNELS[p.channel] ? p.channel : '';
      if (!channel) return undefined;
      var prevShare = lastChannelAt[channel] || 0;
      if (nowMs - prevShare < SHARE_DEBOUNCE_MS) return null;
      lastChannelAt[channel] = nowMs;
      return {
        schemaVersion: SCHEMA_VERSION,
        event: 'tarot_share_click',
        page: 'lp',
        channel: channel,
        ts: new Date(nowMs).toISOString()
      };
    }

    return undefined;
  }

  function track(eventName, props) {
    try {
      var payload = buildCleanPayload(eventName, props);
      if (payload === undefined) {
        return false;
      }
      if (payload === null) {
        stats.deduplicated += 1;
        return false;
      }
      events.push(payload);
      stats.total += 1;
      sendPayload(payload);
      return true;
    } catch (_) {
      return false;
    }
  }

  function resetTarotDraw() {
    tarotDrawnSinceReset = false;
  }

  function resetForTest() {
    events = [];
    stats = {
      total: 0,
      sent: 0,
      failed: 0,
      skippedUnconfigured: 0,
      deduplicated: 0
    };
    lpViewed = false;
    tarotDrawnSinceReset = false;
    lastTarotAt = 0;
    lastPlacementAt = {};
    lastChannelAt = {};
  }

  window.__omochiKpi = {
    track: track,
    resetTarotDraw: resetTarotDraw,
    resetForTest: resetForTest,
    getEvents: function () {
      return events.slice();
    },
    getStats: function () {
      return {
        total: stats.total,
        sent: stats.sent,
        failed: stats.failed,
        skippedUnconfigured: stats.skippedUnconfigured,
        deduplicated: stats.deduplicated
      };
    }
  };
})();
