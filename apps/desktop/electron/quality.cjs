'use strict';
// Adaptive screen-quality controller (weak-network Layer 2, plans/weak-network.md).
//
// PURE and deterministic: no timers, no IO, no clock. The caller (the frame loop)
// reports each frame outcome with observe() and asks next() what to request and how
// long to wait. Randomness (backoff jitter) comes from an injectable `random`.
//
// Levels (best first). Capabilities clamp them; levels that collapse to the same
// request (e.g. no scale and no JPEG) are merged, so Auto never "adapts" to a no-op.

const LEVELS = Object.freeze([
  Object.freeze({ id: 'sharp', label: 'Sharp', scale: 1, format: 'png' }),
  Object.freeze({ id: 'balanced', label: 'Balanced', scale: 0.75, format: 'jpeg', quality: 75 }),
  Object.freeze({ id: 'saver', label: 'Data saver', scale: 0.5, format: 'jpeg', quality: 55 }),
]);
const PRESETS = Object.freeze(['auto', 'sharp', 'balanced', 'saver']);
const BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000, 8000]);
// 401/403: access revoked; 410: the host ended the session (D2). Never retried.
const TERMINAL_STATUSES = Object.freeze({ 401: 'access revoked', 403: 'access denied', 410: 'session ended by the host' });

const DEFAULTS = Object.freeze({
  budgetMs: 350,       // Target time for one screen update.
  intervalMs: 260,     // Normal pause between updates (matches the current App.tsx loop).
  slowToStepDown: 2,   // Consecutive over-budget changed frames before stepping down.
  goodToStepUp: 10,    // Consecutive good frames before probing the next better level.
  upFraction: 0.9,     // "Good" = the better level is PREDICTED to take <= 90 % of the budget (hysteresis).
  collapseFactor: 3,   // Slow-streak mean >= collapseFactor x budget jumps straight to the lowest level.
  maxProbePenalty: 3,  // A failed upgrade doubles goodToStepUp, at most 2^3 = 8x.
  idleToRefine: 3,     // Consecutive unchanged (304) frames before the one-shot Sharp refine.
  jitterFraction: 0.2, // Backoff delay is reduced by up to 20 %, so it never exceeds the schedule.
  alpha: 0.3,          // EWMA weight of the newest sample.
});

function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Applies host capabilities to a level; returns the request it actually maps to. */
function clampLevel(level, caps) {
  const out = { id: level.id, label: level.label, scale: caps.canScale ? level.scale : 1, format: 'png' };
  if (level.format === 'jpeg' && caps.canJpeg) { out.format = 'jpeg'; out.quality = level.quality; }
  return Object.freeze(out);
}
const requestKey = l => `${l.scale}|${l.format}|${l.quality ?? ''}`;
// Rough relative body size, used only until a level's real size has been observed.
// From plans/weak-network.md and docs/PERFORMANCE.md: PNG ~ scale^1.4; JPEG q75-80 ~ 1/3 of PNG, q55-60 ~ 1/4.
const nominalSize = l => l.scale ** 1.4 * (l.format === 'png' ? 1 : l.quality >= 70 ? 0.33 : 0.25);

/** Distinct clamped levels, best first. The first level with a given request keeps its name. */
function availableLevels(caps) {
  const seen = new Set();
  return LEVELS.map(l => clampLevel(l, caps)).filter(l => !seen.has(requestKey(l)) && seen.add(requestKey(l)));
}

function createQualityController(options = {}) {
  const caps = { canScale: !!options.capabilities?.canScale, canJpeg: !!options.capabilities?.canJpeg,
    canConditional: !!options.capabilities?.canConditional };
  const preset = options.preset ?? 'auto';
  if (!PRESETS.includes(preset)) throw new Error(`Unknown quality preset: ${preset}`);
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (Number.isFinite(options[key])) cfg[key] = options[key];
  const random = typeof options.random === 'function' ? options.random : Math.random;

  let levels = availableLevels(caps);
  const s = {
    levelIndex: 0, ewmaMs: undefined, kbps: undefined, bytesAt: new Map(), slowStreak: 0, slowSum: 0, goodStreak: 0,
    probePenalty: 0, probing: null, idleStreak: 0, refine: 'none', // none | pending (next frame is Sharp) | holding (idle at Sharp)
    attempt: 0, delayMs: cfg.intervalMs, terminal: null, lastStatus: undefined, reason: '',
  };

  const pinnedIndex = () => {
    const wanted = clampLevel(LEVELS.find(l => l.id === preset), caps);
    return Math.max(0, levels.findIndex(l => requestKey(l) === requestKey(wanted)));
  };
  const current = () => levels[preset === 'auto' ? s.levelIndex : pinnedIndex()];
  const goodNeeded = () => cfg.goodToStepUp * 2 ** s.probePenalty;
  const ewma = (prev, x) => (prev === undefined ? x : prev + cfg.alpha * (x - prev));

  function describeCurrent() {
    const level = current();
    if (preset !== 'auto') {
      const wanted = LEVELS.find(l => l.id === preset);
      const missing = [];
      if (wanted.scale !== level.scale) missing.push(`no downscale → scale ${level.scale}`);
      if (wanted.format !== level.format) missing.push('no JPEG → PNG');
      return `${wanted.label} (pinned${missing.length ? `; host has ${missing.join(', ')}` : ''})`;
    }
    if (levels.length === 1) return 'Auto: host cannot reduce quality, Sharp only';
    return `Auto: ${level.label}${s.ewmaMs !== undefined ? `, ${formatMs(s.ewmaMs)} per update` : ''}`;
  }

  function setLevel(index, reason) {
    const from = s.levelIndex;
    s.levelIndex = Math.max(0, Math.min(levels.length - 1, index));
    if (s.levelIndex === from) return false;
    if (s.levelIndex > from && s.probing !== null) { // An upgrade that failed: back off further probes.
      s.probePenalty = Math.min(cfg.maxProbePenalty, s.probePenalty + 1);
      s.probing = null;
    } else if (s.levelIndex < from) s.probing = 0;
    s.slowStreak = 0; s.slowSum = 0; s.goodStreak = 0; s.ewmaMs = undefined; // Timing is level-specific.
    s.reason = reason(levels[s.levelIndex]);
    return true;
  }

  /**
   * Expected time at the next better level: this frame's time plus the extra bytes at the
   * measured throughput. Throughput includes TLS setup and encode time, so it underestimates
   * the link and the prediction errs on the slow side. Learned sizes replace the nominal ratio.
   */
  function predictBetterMs(ms, bytes) {
    const now = current(), better = levels[s.levelIndex - 1];
    const known = Number.isFinite(bytes) && bytes > 0 ? bytes : s.bytesAt.get(requestKey(now));
    const ratio = nominalSize(better) / nominalSize(now);
    if (!known || !s.kbps) return ms * ratio; // No size data: assume time scales with size.
    const betterBytes = s.bytesAt.get(requestKey(better)) ?? known * ratio;
    return ms + Math.max(0, betterBytes - known) * 8 / s.kbps;
  }

  function observeChanged(ms, bytes) {
    if (preset !== 'auto' || levels.length === 1) return;
    s.ewmaMs = ewma(s.ewmaMs, ms);
    if (s.probing !== null && ++s.probing >= cfg.goodToStepUp) { s.probing = null; s.probePenalty = 0; } // Upgrade held.
    if (ms > cfg.budgetMs) {
      s.goodStreak = 0;
      s.slowSum += ms;
      if (++s.slowStreak < cfg.slowToStepDown) return;
      const avg = s.slowSum / s.slowStreak; // Mean of the slow streak: what the user just felt.
      s.slowStreak = 0; s.slowSum = 0;
      const target = avg >= cfg.collapseFactor * cfg.budgetMs ? levels.length - 1 : s.levelIndex + 1;
      if (!setLevel(target, l => `slow link: ${formatMs(avg)} per update → ${l.label}`))
        s.reason = `slow link: ${formatMs(avg)} per update, already at ${current().label}`;
      return;
    }
    s.slowStreak = 0; s.slowSum = 0;
    if (s.levelIndex === 0) return;
    if (predictBetterMs(ms, bytes) > cfg.upFraction * cfg.budgetMs) { s.goodStreak = 0; return; } // Hysteresis band: hold.
    if (++s.goodStreak >= goodNeeded()) {
      const avg = s.ewmaMs;
      setLevel(s.levelIndex - 1, l => `link improved: ${formatMs(avg)} per update → ${l.label}`);
    }
  }

  function observe(sample = {}) {
    if (s.terminal) return api.state;
    const status = Number.isInteger(sample.status) ? sample.status : undefined;
    s.lastStatus = status;
    if (status !== undefined && TERMINAL_STATUSES[status]) {
      s.terminal = { status, reason: `${TERMINAL_STATUSES[status]} (${status})` };
      s.reason = s.terminal.reason;
      return api.state;
    }
    const unchanged = !!sample.unchanged || status === 304;
    const ok = sample.ok !== false && (status === undefined || status === 304 || (status >= 200 && status < 300));
    if (!ok) {
      // A host that predates JPEG rejects format=jpeg with 400: drop JPEG and retry at once.
      if (status === 400 && caps.canJpeg && current().format === 'jpeg') {
        const label = current().label;
        caps.canJpeg = false;
        levels = availableLevels(caps);
        s.levelIndex = Math.min(s.levelIndex, levels.length - 1);
        s.delayMs = cfg.intervalMs;
        s.reason = `host refused JPEG → ${label} as PNG`;
        return api.state;
      }
      s.attempt += 1;
      const base = BACKOFF_MS[Math.min(s.attempt, BACKOFF_MS.length) - 1];
      const r = Math.min(1, Math.max(0, Number(random()) || 0));
      s.delayMs = Math.round(base * (1 - cfg.jitterFraction * r));
      s.slowStreak = 0; s.slowSum = 0; s.goodStreak = 0; s.idleStreak = 0;
      s.reason = `${status ? `device error (${status})` : 'connection lost'}: retry ${s.attempt} in ${formatMs(s.delayMs)}`;
      return api.state;
    }
    const recovered = s.attempt > 0;
    s.attempt = 0;
    s.delayMs = cfg.intervalMs;
    s.reason = recovered ? `reconnected → ${describeCurrent()}` : '';

    if (unchanged) { // Idle screen: keep the level; refine once to Sharp for crisp text.
      s.idleStreak += 1;
      if (s.refine === 'pending') s.refine = 'holding';
      const refinable = preset === 'auto' && current() !== levels[0];
      if (s.refine === 'none' && refinable && caps.canConditional && s.idleStreak >= cfg.idleToRefine) {
        s.refine = 'pending';
        s.reason = `screen idle → ${levels[0].label} refresh for text`;
      }
      return api.state;
    }
    const ms = Number(sample.ms);
    const bytes = Number(sample.bytes);
    if (Number.isFinite(ms) && ms > 0 && Number.isFinite(bytes) && bytes > 0) {
      s.kbps = ewma(s.kbps, (bytes * 8) / ms);
      const asked = s.refine === 'none' ? current() : levels[0]; // What this frame was requested as.
      s.bytesAt.set(requestKey(asked), ewma(s.bytesAt.get(requestKey(asked)), bytes));
    }
    s.idleStreak = 0;
    if (s.refine === 'pending') { s.refine = 'holding'; return api.state; } // The refine frame itself: don't adapt on it.
    if (s.refine === 'holding') { // Motion after a refine: back to the adapted level, skip this Sharp-sized sample.
      s.refine = 'none';
      s.reason = `motion resumed → ${current().label}`;
      return api.state;
    }
    if (Number.isFinite(ms) && ms >= 0) observeChanged(ms, bytes);
    return api.state;
  }

  function next() {
    if (s.terminal) return { terminal: true, delayMs: null, reason: s.terminal.reason, attempt: s.attempt, level: current().id };
    const refining = s.refine === 'pending' || s.refine === 'holding';
    const level = refining ? levels[0] : current();
    const out = { scale: level.scale, format: level.format, delayMs: s.delayMs, level: level.id,
      attempt: s.attempt, reason: s.reason || describeCurrent(), terminal: false };
    if (level.format === 'jpeg') out.quality = level.quality;
    return out;
  }

  function reset() { // Monitor switch: keep the level, forget per-screen streaks and timing.
    Object.assign(s, { ewmaMs: undefined, slowStreak: 0, slowSum: 0, goodStreak: 0, idleStreak: 0, refine: 'none', probing: null, reason: '' });
  }

  const api = {
    observe, next, reset,
    get state() {
      const best = preset === 'auto' ? s.levelIndex === 0 : true;
      const mode = s.terminal ? 'disconnected' : s.attempt > 0 ? 'reconnecting' : best ? 'live' : 'slow';
      return { preset, mode, level: current().id, levels: levels.map(l => l.id), capabilities: { ...caps },
        ewmaMs: s.ewmaMs, kbps: s.kbps, slowStreak: s.slowStreak, goodStreak: s.goodStreak, goodNeeded: goodNeeded(),
        idleStreak: s.idleStreak, refining: s.refine === 'pending' || s.refine === 'holding', attempt: s.attempt,
        delayMs: s.delayMs, terminal: s.terminal, lastStatus: s.lastStatus };
    },
  };
  return api;
}

module.exports = { createQualityController, availableLevels, clampLevel, formatMs, LEVELS, PRESETS, BACKOFF_MS, TERMINAL_STATUSES, DEFAULTS };
