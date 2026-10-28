'use strict';
const crypto = require('node:crypto');
const { remoteStream, isDisplayAsleep, DISPLAY_ASLEEP_MESSAGE } = require('./transport.cjs');
const { neutralText } = require('./peer-data.cjs');
const { OrbitStreamParser, StreamProtocolError } = require('./stream-parser.cjs');
const { SECURITY_TERMINAL, IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');

const SESSION_TERMINAL = new Set(['session_ended', 'session_ended_by_host', 'stream_replaced', ...SECURITY_TERMINAL]);
const ACK_INTERVAL_MS = 1000 / 30; // c993263: cumulative receipt acknowledgements at most30Hz.
const MAX_STREAMS = 8;
const MAX_QUEUED_RECORDS = 12;
// Records main may post to the renderer before the decoder Worker returns credit (S2). The Worker admits at most this
// many messages (renderer/src/stream/decoder-admission.ts, VIDEO_CREDIT_WINDOW) and returns one credit per handled message.
const VIDEO_CREDIT_WINDOW = 3;
// AUs posted but not yet presented, superseded or dropped can sit in: the decoder (it recovers above 12 waiting, or after
// 500 ms), the credit window, and the one decoded frame waiting for display. Three more for margin, as before the window.
const MAX_UNCONSUMED_UNITS = 12 + VIDEO_CREDIT_WINDOW + 1 + 3;
const RETRYABLE_FALLBACK = new Set(['stream_eof', 'stream_stalled', 'decoder_stalled', 'decoder_unavailable',
  'stream_restart', 'stream_error', 'host_stopping', 'session_reconnected']);
const RETRYABLE_NETWORK = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ORBIT_STREAM_STALLED',
  'ORBIT_STREAM_CONNECT_TIMEOUT', 'ORBIT_TLS_HANDSHAKE_TIMEOUT', 'ORBIT_REQUEST_TIMEOUT', 'ORBIT_REQUEST_DEADLINE',
  'ORBIT_LOCAL_HOST_RESTARTING', 'ORBIT_LOCAL_HOST_RESTARTED']);
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60000;
// Failure text can come from the remote host: bounded, with unsafe characters neutralised (peer-data.cjs).
const text = value => neutralText(value == null ? undefined : String(value)) || 'Video stream unavailable.';
const CAPACITY_MESSAGE = 'Video is busy. Up to 4 screens per device and 8 per host can use video. Close a screen or try again later.';
const failureText = (value, code) => IDENTITY_TERMINAL.has(code) ? IDENTITY_CHANGED_MESSAGE : code === 'stream_capacity' ? CAPACITY_MESSAGE : text(value);

// A renderer hint, never an input or wake authorization. Remote session IDs and
// resume credentials stay in main. Missing legacy capabilities fail closed.
function sessionAvailability(sessionId, session) {
  const generation = session?.sessionGeneration ?? 0;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || /[\x00-\x1f\x7f]/.test(sessionId)
    || !Number.isSafeInteger(generation) || generation < 0 || typeof session?.viewOnly !== 'boolean') return undefined;
  return { sessionId, sessionGeneration: generation, canWakeDisplay: session.canWakeDisplay === true,
    controlGranted: session.permissions?.control === true, viewOnly: session.viewOnly };
}
function asleepDetail(availability) {
  return { code: 'display_asleep', status: 409, displayState: 'off', retryable: true,
    ...(availability ? { availability } : {}) };
}

function streamErrorPolicy(error) {
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
  const terminal = SECURITY_TERMINAL.has(error?.code) && (!IDENTITY_TERMINAL.has(error.code) || error.status === undefined) ? error.code
    : status === 410 ? 'session_ended_by_host' : status === 401 ? 'access_revoked' : status === 403 ? 'permission_changed' : null;
  return { status, terminal, retryable: !terminal && !(error instanceof StreamProtocolError)
    && (isDisplayAsleep(error) || (status === undefined ? RETRYABLE_NETWORK.has(error?.code) : RETRYABLE_HTTP.has(status))) };
}

// Electron throws away custom Error fields over invoke. Return bounded metadata
// for this one action so the viewer can distinguish a denied open from a retry.
function streamOpenError(error, endedReason) {
  const policy = streamErrorPolicy(error);
  const terminal = policy.terminal || (endedReason ? 'session_ended' : null);
  if (!terminal && isDisplayAsleep(error)) return { error: { message: DISPLAY_ASLEEP_MESSAGE, ...asleepDetail(error.availability) } };
  const code = terminal || (policy.status === 429 && error?.code === 'stream_capacity' ? 'stream_capacity' : 'stream_open_denied');
  return { error: { message: failureText(endedReason || error?.message, code), code,
    retryable: code === 'stream_capacity', ...(policy.status !== undefined ? { status: policy.status } : endedReason && !policy.terminal ? { status: 410 } : {}) } };
}
function frameRequestError(error, endedReason, canReconnect = false) {
  const { error: detail } = streamOpenError(error, endedReason), policy = streamErrorPolicy(error);
  if (detail.code === 'display_asleep') return { error: detail };
  return { error: { ...detail, ...(policy.terminal || endedReason ? {} : { code: 'stream_unavailable', retryable: policy.retryable }),
    ...(canReconnect && policy.status === 410 && !SECURITY_TERMINAL.has(policy.terminal) ? { canReconnect: true } : {}) } };
}
function wakeDisplayError(error, endedReason) {
  const { error: detail } = streamOpenError(error, endedReason), policy = streamErrorPolicy(error);
  if (policy.terminal || endedReason) return { error: { ...detail, retryable: false } };
  const code = policy.status === 429 && error?.code === 'wake_rate_limited' ? 'wake_rate_limited'
    : policy.status === 409 && error?.code === 'wake_unsupported' ? 'wake_unsupported'
    : error?.status === undefined && error?.code === 'wake_not_permitted' ? 'wake_not_permitted'
    : error?.code === 'wake_cancelled' ? 'wake_cancelled' : 'wake_failed';
  return { error: { message: code === 'wake_rate_limited' ? 'Wait a moment before requesting display wake again.'
    : code === 'wake_unsupported' ? 'Display wake is unavailable for this session.'
    : code === 'wake_not_permitted' ? 'Control permission is required to request display wake.'
    : code === 'wake_cancelled' ? 'The screen changed before display wake completed.' : 'The display wake request could not be completed.',
    code, retryable: false, ...(policy.status !== undefined ? { status: policy.status } : {}),
    ...(code === 'wake_rate_limited' && error.retryAfterSeconds === 5 ? { retryAfterSeconds: 5 } : {}) } };
}

// One MessagePort belongs to one authenticated Electron frame, session and
// selected monitor. Main creates the port and passes its owner identity; those
// values never come from a record or a renderer-supplied connection address.
class SessionVideoStreams {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.openRemote = options.remoteStream || remoteStream;
    this.now = options.now || (() => performance.now());
    this.onTerminal = options.onTerminal || (() => {});
    this.onPresented = options.onPresented || (() => {});
    this.ackInterval = options.ackInterval ?? ACK_INTERVAL_MS;
    this.entries = new Map();
    this.controlFlights = new Map();
    // Parse time per queued access unit, on main's clock only (viewer timing, S1).
    this.parsedAt = new WeakMap();
  }

  open(payload, port, owner) {
    if (!Number.isInteger(owner) || owner <= 0 || !port || typeof port.postMessage !== 'function') throw new Error('Invalid stream owner.');
    const session = this.controller.getSession(payload);
    if (session.permissions?.view !== true) throw new Error('Viewing permission is unavailable.');
    if (payload.cursor !== undefined && !['local', 'video'].includes(payload.cursor)) throw new Error('Invalid cursor mode.');
    if (payload.cursor === 'local' && session.canLocalCursor !== true) throw new Error('Local cursor support was not advertised by this host.');
    const requested = payload.monitorId || session.monitorId;
    const monitor = requested ? session.monitors.find(m => m.id === requested) : session.monitors.find(m => m.primary) || session.monitors[0];
    if (!monitor || typeof monitor.id !== 'string' || !monitor.id || monitor.id.length > 128 || /[\x00-\x1f\x7f]/.test(monitor.id))
      throw new Error('Choose an available remote monitor.');
    const finite = (value, fallback, min, max, integral) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'number' || !Number.isFinite(value) || (integral && !Number.isInteger(value))) throw new Error('Invalid video settings.');
      return Math.max(min, Math.min(max, value));
    };
    const settings = { maxFps: finite(payload.maxFps, 60, 1, 240, true), bitrateBps: finite(payload.bitrateBps, 8_000_000, 100_000, 100_000_000, true),
      scale: finite(payload.scale, 1, .33, 1, false), localCursor: payload.cursor === 'local' };
    for (const existing of this.entries.values()) if (existing.sessionId === payload.sessionId && existing.monitorId === monitor.id) {
      if (existing.owner !== owner) throw new Error('This display already has a video stream in another window. Use image updates here.');
      this.close(existing.id, owner);
    }
    if (this.entries.size >= MAX_STREAMS) throw new Error('Close another video stream first.');
    const entry = { id: crypto.randomUUID(), owner, port, session, sessionId: payload.sessionId, remoteId: session.remoteId,
      monitorId: monitor.id, sessionGeneration: session.sessionGeneration ?? 0, slotKey: Object.hasOwn(payload, 'monitorId') ? payload.monitorId || '' : session.monitorId || '',
      settings, aborter: new AbortController(), queue: [], pending: new Map(), credit: 0, inFlight: [], closed: false,
      started: this.now(), everCredit: false, lastControl: -Infinity, lastKeyframe: -Infinity,
      settingsPending: null, ack: null, lastAckSent: -1, lastDecodeMs: 0, roundTripMs: undefined, roundTripAt: 0, keyframe: false, controlBusy: false, config: null, geometry: null, lastSentSequence: -1,
      messageWindow: this.now(), messageCount: 0, pointer: null, pointerShape: null, pointerSentShape: null, pointerOutstanding: null,
      pointerSentAt: 0, lastPointerSent: -Infinity, deliveredConfig: null, pointerTimer: null };
    entry.parser = new OrbitStreamParser({ monitorId: monitor.id, allowCursor: settings.localCursor, onRecord: record => this.record(entry, record) });
    this.entries.set(entry.id, entry);
    this.clearGeometry(entry, true);
    port.on('message', event => {
      try { this.message(entry, event.data); }
      catch { this.finish(entry, { state: 'fallback', code: 'invalid_worker_message', error: 'The video decoder channel failed.' }); }
    });
    port.on('close', () => this.close(entry.id, owner));
    port.start();
    entry.timer = setInterval(() => {
      if (!this.current(entry)) return this.finish(entry, this.inactiveStatus(entry));
      const now = this.now();
      // The Worker handles records in order, so the oldest uncredited record shows whether it stopped responding.
      if ((!entry.everCredit && now - entry.started > 10000) || (entry.inFlight.length && now - entry.inFlight[0] > 5000)
        || [...entry.pending.values()].some(sample => now - sample.sentAt > 5000)
        || (entry.pointerOutstanding !== null && now - entry.pointerSentAt > 5000))
        this.finish(entry, { state: 'fallback', code: 'decoder_stalled', error: 'The video decoder stopped responding. Using image updates.' });
    }, 250);
    entry.timer.unref?.();
    this.post(entry, { type: 'status', state: 'connecting' });
    // Connecting is cancellable before the remoteStream handle exists.
    entry.connecting = this.connect(entry);
    return { streamId: entry.id, monitorId: monitor.id };
  }

  current(entry) {
    return !entry.closed && !entry.session.closed && this.controller.sessions.get(entry.sessionId) === entry.session
      && entry.session.remoteId === entry.remoteId && (entry.session.sessionGeneration ?? 0) === entry.sessionGeneration
      && entry.session.permissions?.view === true;
  }

  inactiveStatus(entry) {
    // Another authorized image window can renew a missing remote session. Its
    // new generation invalidates this stream, but does not end the new session.
    const renewed = !entry.session.closed && this.controller.sessions.get(entry.sessionId) === entry.session
      && entry.session.permissions?.view === true && (entry.session.remoteId !== entry.remoteId || (entry.session.sessionGeneration ?? 0) !== entry.sessionGeneration);
    return renewed ? { state: 'fallback', code: 'session_reconnected', error: 'The session reconnected. Using image updates.' }
      : { state: 'ended', code: 'session_ended', error: 'This session has ended. Connect again explicitly.' };
  }

  post(entry, message) {
    if (entry.closed) return;
    try { entry.port.postMessage(message); }
    catch { this.close(entry.id, entry.owner); }
  }

  controlKey(entry) { return JSON.stringify([entry.sessionId, entry.remoteId, entry.monitorId]); }

  async connect(entry) {
    try {
      // Host controls address session+monitor, so a late old POST must finish
      // before a replacement GET registers a new run for that same target.
      await this.controlFlights.get(this.controlKey(entry))?.catch(() => {});
      if (!this.current(entry)) return this.close(entry.id, entry.owner);
      const identity = await this.controller.getIdentity();
      if (!this.current(entry)) return this.close(entry.id, entry.owner);
      // Use the latest selection already received while identity/fence work
      // was pending. Later selections still queue a control after GET200.
      if (entry.settingsPending !== null) {
        entry.settings.scale = entry.settingsPending;
        entry.settingsPending = null;
      }
      const query = new URLSearchParams({ monitorId: entry.monitorId, codec: 'avc1', maxFps: String(entry.settings.maxFps),
        bitrate: String(entry.settings.bitrateBps), scale: String(entry.settings.scale) });
      if (entry.settings.localCursor) query.set('cursor', 'local');
      const connection = await this.openRemote(entry.session.device, identity,
        '/api/sessions/' + encodeURIComponent(entry.remoteId) + '/stream?' + query,
        { signal: entry.aborter.signal, onData: bytes => {
          if (!this.current(entry)) { this.close(entry.id, entry.owner); return false; }
          try { entry.parser.push(bytes); }
          catch (error) {
            this.finish(entry, { state: 'fallback', code: error instanceof StreamProtocolError ? 'stream_protocol_error' : 'stream_consumer_error',
              error: 'The device sent an invalid video stream. Using image updates.' });
            return false;
          }
          return !entry.closed && entry.queue.length === 0;
        } }, this.controller.allowLoopback);
      entry.connection = connection;
      if (!this.current(entry)) { connection.abort(); return; }
      this.post(entry, { type: 'status', state: 'connected', link: connection.link });
      this.scheduleControl(entry);
      if (entry.queue.length === 0) connection.resume();
      try {
        await connection.done;
        if (entry.closed) return;
        const eof = entry.parser.finish();
        if (!eof.terminal) this.finish(entry, { state: 'fallback', code: 'stream_eof', error: 'The video stream ended. Using image updates.' });
      } catch (error) { if (!entry.closed) this.failure(entry, error); }
    } catch (error) { if (!entry.closed) this.failure(entry, error); }
  }

  record(entry, record) {
    if (!this.current(entry)) return this.close(entry.id, entry.owner);
    if (record.type === 'terminal') {
      // Identity comparison belongs to the local TLS transport. The parser
      // already filters reserved codes; keep this remote-record sink defensive.
      const code = IDENTITY_TERMINAL.has(record.code) ? 'stream_error' : record.code;
      if (code === 'display_asleep') {
        const availability = sessionAvailability(entry.sessionId, entry.session);
        this.controller.noteDisplayAsleep?.(entry.sessionId, entry.session);
        this.clearGeometry(entry, true);
        this.finish(entry, { state: 'fallback', error: DISPLAY_ASLEEP_MESSAGE, ...asleepDetail(availability) });
        return;
      }
      const reason = failureText(record.error, code);
      if (code === 'host_stopping' || code === 'stream_restart') this.controller.noteHostStopping?.(entry.sessionId, code);
      else if (SECURITY_TERMINAL.has(code)) this.controller.reconnectTargets?.delete(entry.sessionId);
      if (SESSION_TERMINAL.has(code)) this.invalidate(entry, code, reason);
      this.finish(entry, { state: SESSION_TERMINAL.has(code) ? 'ended' : 'fallback', code, error: reason });
      return;
    }
    if (record.type === 'heartbeat') return;
    if (record.type === 'cursor') {
      if (record.cursor.shape) entry.pointerShape = { id: record.cursor.shapeId, shape: record.cursor.shape };
      entry.pointer = { record, shape: entry.pointerShape, config: entry.config };
      this.flushCursor(entry); return;
    }
    if (record.type === 'config') {
      this.dropPending(entry);
      entry.config = record.config;
      entry.pointer = null; entry.pointerShape = null; entry.pointerSentShape = null;
      entry.queue = entry.queue.filter(item => item.type !== 'access-unit');
      this.clearGeometry(entry, true);
    } else {
      if (entry.pending.size + entry.queue.filter(item => item.type === 'access-unit').length >= MAX_UNCONSUMED_UNITS)
        throw new StreamProtocolError('The video consumer exceeded its bounded window.');
      // Acknowledge only a fully received, validated AU. Presentation remains
      // separate telemetry; the decoder has its own bounded queue and drops.
      this.parsedAt.set(record, this.now());
      this.ack(entry, record.sequence);
    }
    if (entry.queue.length >= MAX_QUEUED_RECORDS) throw new StreamProtocolError('The video record queue is full.');
    entry.queue.push(record); this.pump(entry);
  }

  pump(entry) {
    // One record per credit, up to VIDEO_CREDIT_WINDOW in flight. flushCursor may re-enter; each pass re-checks credit.
    while (this.current(entry) && entry.credit > 0 && entry.queue.length) {
      // A hidden-pointer transition must reach the renderer before a following
      // composited frame, even while the preceding pointer awaits consumption.
      if (entry.queue[0].type === 'access-unit' && entry.pointer?.record.cursor.visible === false) return;
      this.sendRecord(entry, entry.queue.shift());
    }
  }

  sendRecord(entry, record) {
    const now = this.now(), parsedAt = this.parsedAt.get(record);
    entry.credit--; entry.inFlight.push(now);
    if (record.type === 'access-unit') {
      entry.pending.set(record.sequence, { config: entry.config, sentAt: now });
      entry.lastSentSequence = record.sequence;
    }
    if (record.type === 'config') entry.deliveredConfig = record.config;
    // No transfer list: MessagePortMain transfers only ports (an ArrayBuffer
    // throws and post() closes the stream). The cross-process copy is required.
    // Viewer timing rides on the record message: main's queue wait for this
    // record and the latest control round trip with its age, all durations on
    // main's clock (never timestamps).
    const message = { type: 'record', record };
    if (record.type === 'config') message.sessionGeneration = entry.sessionGeneration;
    if (parsedAt !== undefined) message.mainQueueMs = Math.max(0, now - parsedAt);
    if (entry.roundTripMs !== undefined) {
      message.rttMs = entry.roundTripMs; message.rttAgeMs = Math.max(0, now - entry.roundTripAt); entry.roundTripMs = undefined;
    }
    this.post(entry, message);
    this.flushCursor(entry);
    if (!entry.queue.length && !entry.closed) entry.connection?.resume();
  }

  message(entry, message) {
    if (entry.closed) return;
    if (!this.current(entry)) return this.finish(entry, this.inactiveStatus(entry));
    const now = this.now();
    if (now - entry.messageWindow >= 1000) { entry.messageWindow = now; entry.messageCount = 0; }
    if (++entry.messageCount > 2000 || !message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid decoder channel.');
    if (message.type === 'settings') {
      if (Object.keys(message).some(key => !['type', 'scale'].includes(key)) || typeof message.scale !== 'number' || !Number.isFinite(message.scale) || message.scale < .33 || message.scale > 1)
        throw new Error('Invalid video settings.');
      entry.settingsPending = message.scale; this.scheduleControl(entry); return;
    }
    if (message.type === 'cursor-consumed') {
      if (!uint(message.sequence) || message.sequence !== entry.pointerOutstanding) throw new Error('Invalid cursor consumption.');
      entry.pointerOutstanding = null; this.flushCursor(entry); return;
    }
    if (message.type === 'credit') {
      // Main is the trust boundary. The first grant is at most the window; every later credit returns records that main
      // actually posted and that are still uncredited, so a doubled or invented credit cannot widen the window.
      if (!Number.isInteger(message.count) || message.count < 1 || entry.credit + message.count > VIDEO_CREDIT_WINDOW
        || (entry.everCredit && message.count > entry.inFlight.length)) throw new Error('Invalid decoder credit.');
      // Credits return in send order; the first grant has nothing in flight.
      entry.credit += message.count; entry.inFlight.splice(0, message.count); entry.everCredit = true; this.pump(entry); return;
    }
    if (message.type === 'consumed') {
      if (!uint(message.sequence) || typeof message.dropped !== 'boolean') throw new Error('Invalid decoder consumption.');
      if (message.dropped) entry.pending.delete(message.sequence);
      return;
    }
    if (message.type === 'superseded') {
      // Decoded, then replaced by a newer frame before the next display refresh. Not a drop and not a presentation.
      if (!uint(message.sequence)) throw new Error('Invalid decoder supersession.');
      entry.pending.delete(message.sequence); return;
    }
    if (message.type === 'presented') {
      if (!uint(message.sequence) || !duration(message.decodeMs) || !duration(message.drawMs)) throw new Error('Invalid presentation.');
      const sample = entry.pending.get(message.sequence);
      if (!sample) return; // Output already discarded during a generation change.
      entry.pending.delete(message.sequence);
      entry.lastDecodeMs = message.decodeMs;
      const c = sample.config;
      if (c) {
        const geometry = { width: c.physicalWidth, height: c.physicalHeight, left: c.physicalLeft, top: c.physicalTop };
        const slot = this.slot(entry); slot.frame = geometry; slot.cache = null; entry.geometry = geometry;
        if (entry.monitorId === (entry.session.monitorId || entry.session.monitors.find(m => m.primary)?.id || entry.session.monitors[0]?.id)) entry.session.frame = geometry;
      }
      this.controller.reconnectTargets?.delete(entry.sessionId);
      this.onPresented(entry);
      return;
    }
    if (message.type === 'keyframe-needed') {
      // No blanket clear: the decoder reports each unit it discarded as consumed/dropped. Units admitted or in transit
      // after the reset (possibly the keyframe that ends recovery) stay pending and are presented normally.
      entry.keyframe = true; this.scheduleControl(entry);
      this.post(entry, { type: 'status', state: 'recovering' }); return;
    }
    if (message.type === 'fault' || message.type === 'closed') {
      this.finish(entry, { state: 'fallback', code: 'decoder_unavailable', error: 'Video decoding is unavailable. Using image updates.' }); return;
    }
    throw new Error('Unknown decoder message.');
  }

  slot(entry) {
    const slots = entry.session.frameSlots ||= new Map();
    let slot = slots.get(entry.slotKey);
    if (!slot) { slot = { frame: null, cache: null, pending: null }; slots.set(entry.slotKey, slot); }
    return slot;
  }

  flushCursor(entry) {
    if (!this.current(entry) || entry.pointerOutstanding !== null || !entry.pointer || entry.pointer.config !== entry.deliveredConfig) return;
    const delay = 1000 / Math.min(60, entry.config.fps) - (this.now() - entry.lastPointerSent);
    if (delay > 0) {
      if (!entry.pointerTimer) { entry.pointerTimer = setTimeout(() => { entry.pointerTimer = null; this.flushCursor(entry); }, Math.ceil(delay)); entry.pointerTimer.unref?.(); }
      return;
    }
    const pending = entry.pointer; entry.pointer = null;
    const cursor = { ...pending.record.cursor };
    if (entry.pointerSentShape !== cursor.shapeId) cursor.shape = pending.shape.shape;
    else delete cursor.shape;
    entry.pointerSentShape = cursor.shapeId; entry.pointerOutstanding = pending.record.sequence;
    entry.pointerSentAt = entry.lastPointerSent = this.now();
    this.post(entry, { type: 'cursor', cursor, sequence: pending.record.sequence });
    this.pump(entry);
  }

  clearGeometry(entry, initializing = false) {
    const slot = this.slot(entry);
    // Invalidate image requests that began before this video generation. A
    // late PNG/304 must never restore its old input origin or cached pixels.
    if (initializing) slot.deliveryToken = {};
    if (initializing || slot.frame === entry.geometry) { slot.frame = null; slot.cache = null; }
    const primary = entry.session.monitorId || entry.session.monitors.find(m => m.primary)?.id || entry.session.monitors[0]?.id;
    if ((initializing && entry.monitorId === primary) || entry.session.frame === entry.geometry) entry.session.frame = null;
    entry.geometry = null;
  }

  ack(entry, sequence) {
    if (sequence <= entry.lastAckSent) return;
    if (!entry.ack || sequence >= entry.ack.sequence) entry.ack = { sequence };
    this.scheduleControl(entry);
  }

  dropPending(entry) {
    entry.pending.clear();
  }

  scheduleControl(entry) {
    if (entry.closed || !entry.connection || entry.controlBusy || (!entry.ack && !entry.keyframe && entry.settingsPending === null)) return;
    const now = this.now();
    const due = entry.ack || entry.settingsPending !== null ? entry.lastControl + this.ackInterval : Math.max(entry.lastControl + this.ackInterval, entry.lastKeyframe + 500);
    if (entry.controlTimer && entry.controlDue <= due) return;
    clearTimeout(entry.controlTimer); entry.controlDue = due;
    entry.controlTimer = setTimeout(() => { entry.controlTimer = null; entry.controlDue = undefined; void this.control(entry); }, Math.max(0, Math.ceil(due - now)));
    entry.controlTimer.unref?.();
  }

  async control(entry) {
    if (!this.current(entry)) return;
    const now = this.now(), body = {};
    if (entry.ack) { body.ack = entry.ack.sequence; body.decodeMs = entry.lastDecodeMs; entry.lastAckSent = entry.ack.sequence; entry.ack = null; }
    if (entry.settingsPending !== null) { body.scale = entry.settingsPending; entry.settings.scale = entry.settingsPending; entry.settingsPending = null; }
    if (entry.keyframe && now - entry.lastKeyframe >= 500) { body.keyframe = true; entry.keyframe = false; entry.lastKeyframe = now; }
    if (!Object.keys(body).length) { this.scheduleControl(entry); return; }
    const controlKey = this.controlKey(entry);
    if (this.controlFlights.size >= 32 && !this.controlFlights.has(controlKey)) {
      this.finish(entry, { state: 'fallback', code: 'stream_unavailable', retryable: true, error: 'Video control is busy. Using image updates.' }); return;
    }
    entry.controlBusy = true; entry.lastControl = now;
    const sentAt = this.now();
    const flight = this.controller.remote(entry.session.device, '/api/sessions/' + encodeURIComponent(entry.remoteId)
        + '/stream/control?monitorId=' + encodeURIComponent(entry.monitorId), { method: 'POST', body });
    this.controlFlights.set(controlKey, flight);
    try {
      await flight;
      const measuredAt = this.now(), roundTrip = measuredAt - sentAt;
      if (duration(roundTrip)) { entry.roundTripMs = roundTrip; entry.roundTripAt = measuredAt; }
    } catch (error) { if (!entry.closed) this.failure(entry, error); }
    finally {
      if (this.controlFlights.get(controlKey) === flight) this.controlFlights.delete(controlKey);
      entry.controlBusy = false; this.scheduleControl(entry);
    }
  }

  invalidate(entry, code, error, cause) {
    if (IDENTITY_TERMINAL.has(code)) this.controller.retireIdentity?.(entry.session.device,
      cause || Object.assign(new Error(failureText(error, code)), { code }));
    if (SECURITY_TERMINAL.has(code)) {
      this.controller.reconnectTargets?.delete(entry.sessionId);
      this.controller.cancelReconnect?.(entry.sessionId);
    }
    const s = entry.session;
    if (this.controller.sessions.get(entry.sessionId) !== s) return;
    this.controller.endedSessions.set(entry.sessionId, text(error || 'This session has ended. Connect again explicitly.'));
    if (this.controller.endedSessions.size > 64) this.controller.endedSessions.delete(this.controller.endedSessions.keys().next().value);
    s.closed = true; s.inputEpoch = (s.inputEpoch || 0) + 1; s.pendingMove = null; s.frame = null;
    for (const slot of s.frameSlots?.values() || []) { slot.frame = null; slot.cache = null; }
    this.controller.sessions.delete(entry.sessionId);
    for (const other of this.entries.values()) if (other !== entry && other.session === s)
      this.finish(other, { state: 'ended', code, error: text(error) });
    this.onTerminal(entry.sessionId, text(error));
  }

  failure(entry, error) {
    const { terminal: code, retryable, status } = streamErrorPolicy(error);
    // A stale informational asleep reply cannot borrow renewed metadata. Keep
    // existing identity/security terminal precedence even for a late failure.
    if (!code && !this.current(entry)) return this.finish(entry, this.inactiveStatus(entry));
    if (!code && isDisplayAsleep(error)) {
      const availability = sessionAvailability(entry.sessionId, entry.session);
      this.controller.noteDisplayAsleep?.(entry.sessionId, entry.session);
      this.clearGeometry(entry, true);
      this.finish(entry, { state: 'fallback', error: DISPLAY_ASLEEP_MESSAGE, ...asleepDetail(availability) });
      return;
    }
    const fallbackCode = status === 429 && error?.code === 'stream_capacity' ? 'stream_capacity' : error instanceof StreamProtocolError ? 'stream_protocol_error' : 'stream_unavailable';
    const reason = failureText(error.message, code || fallbackCode);
    if (code) this.invalidate(entry, code, reason, error);
    this.finish(entry, { state: code ? 'ended' : 'fallback', code: code || fallbackCode,
      error: reason, retryable, ...(status !== undefined ? { status } : {}) });
  }

  finish(entry, status) {
    if (entry.closed) return;
    const availability = status.state === 'fallback' && this.current(entry) ? sessionAvailability(entry.sessionId, entry.session) : undefined;
    this.post(entry, { type: 'status', ...status,
      ...(availability ? { availability } : {}),
      ...(status.state === 'ended' ? { canReconnect: !SECURITY_TERMINAL.has(status.code) && this.controller.canReconnect?.(entry.sessionId) === true } : {}),
      retryable: status.state === 'fallback' && (status.retryable === true || RETRYABLE_FALLBACK.has(status.code)) });
    this.close(entry.id, entry.owner);
  }

  close(id, owner) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.closed) return;
    entry.closed = true; this.entries.delete(id);
    clearInterval(entry.timer); clearTimeout(entry.controlTimer); clearTimeout(entry.pointerTimer);
    entry.aborter.abort(); entry.connection?.abort();
    entry.queue = []; entry.pending.clear(); entry.settingsPending = null; entry.pointer = null; entry.pointerShape = null; this.clearGeometry(entry);
    try { entry.parser.finish(); } catch { /* Failed or terminal parser has no retained payload. */ }
    entry.port.close();
  }

  closeOwner(owner) { for (const entry of this.entries.values()) if (entry.owner === owner) this.close(entry.id, owner); }
  pauseOwner(owner, state) {
    if (state?.paused !== true || !['minimized', 'hidden'].includes(state.reason) || !Number.isSafeInteger(state.revision) || state.revision < 0)
      throw new Error('Invalid native window state.');
    for (const entry of this.entries.values()) if (entry.owner === owner) {
      // The port carries classification before its close event. Window-state
      // IPC may arrive before or after this message without turning pause into
      // an unexpected disconnect or clearing remembered Control.
      this.post(entry, { type: 'status', state: 'paused', windowState: { paused: true, reason: state.reason, revision: state.revision } });
      this.close(entry.id, owner);
    }
  }
  shutdown() { for (const entry of this.entries.values()) this.close(entry.id, entry.owner); }
}

module.exports = { SessionVideoStreams, SESSION_TERMINAL, ACK_INTERVAL_MS, MAX_STREAMS, MAX_UNCONSUMED_UNITS, MAX_QUEUED_RECORDS, VIDEO_CREDIT_WINDOW,
  streamErrorPolicy, streamOpenError, frameRequestError, wakeDisplayError, sessionAvailability };
