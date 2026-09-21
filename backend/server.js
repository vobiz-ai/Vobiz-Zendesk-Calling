/**
 * Vobiz calling backend for the Zendesk CTI app.
 *
 * The browser is the A leg. The panel sends the SIP INVITE itself and this
 * service answers with <Dial><Number> to reach the customer.
 *
 * The obvious design — originate to the customer over the REST API, then bridge
 * the agent's browser in with <Dial><User> — is what this file used to do, and
 * it does not work. Routing *into* a registered WebRTC endpoint is broken
 * platform-side: Vobiz builds a gateway URI it cannot parse and drops its own
 * INVITE ("tr_eval_uri(): invalid uri", "blocking gw"). See ISSUES.md.
 *
 * Contract and rationale: ../../README.md and ISSUES.md in this folder.
 */
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();

const { syncCallToZendesk, appendTranscription } = require('./zendeskService');

// ─── config ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8092);
const AUTH_ID = process.env.VOBIZ_AUTH_ID;
const AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN;
const FROM_NUMBER = process.env.VOBIZ_FROM_NUMBER;
const SIP_USER = process.env.VOBIZ_SIP_USER;
const SIP_PASSWORD = process.env.VOBIZ_SIP_PASSWORD;
const REGISTRAR = process.env.VOBIZ_REGISTRAR || 'registrar.vobiz.ai';
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

// Used to sign recording URLs. Regenerated on restart if unset, which only
// means previously-issued playback links stop working — never a security hole.
const SIGNING_SECRET = process.env.SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
const RECORDING_URL_TTL_SECONDS = Number(process.env.RECORDING_URL_TTL_SECONDS || 300);

const API_BASE = 'https://api.vobiz.ai/api/v1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const [name, value] of Object.entries({ VOBIZ_AUTH_ID: AUTH_ID, VOBIZ_AUTH_TOKEN: AUTH_TOKEN, VOBIZ_FROM_NUMBER: FROM_NUMBER, VOBIZ_SIP_USER: SIP_USER, VOBIZ_SIP_PASSWORD: SIP_PASSWORD })) {
  if (!value) log(`⚠  ${name} is not set in .env — the panel will not be able to register or call.`);
}

// ─── state ───────────────────────────────────────────────────────────────────
// token -> { agentId, authId, numbers, from, createdAt }
//
// The Auth Token itself is deliberately NOT kept per session: this backend is
// bound to one account through .env and uses those credentials for every Vobiz
// call. /login only proves the agent knows them. Nothing the browser holds can
// be replayed against the Vobiz API.
const sessions = new Map();
// SIP username -> caller ID the agent picked. The /answer webhook has no session
// (it is Vobiz calling us), so this is how it learns which number to dial out on.
const fromBySipUser = new Map();
// A-leg CallUUID -> call record. Recordings are attributed to the A-leg UUID,
// which is what makes this the right key for both the dial result and the file.
const callsByUuid = new Map();
const recentCalls = [];   // newest first, capped

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function newSession(agentId, authId, numbers, from) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { agentId, authId, numbers, from, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return s;
}

function requireSession(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.session = s;
  next();
}

function rememberCall(record) {
  callsByUuid.set(record.callUuid, record);
  recentCalls.unshift(record);
  while (recentCalls.length > 200) {
    const dropped = recentCalls.pop();
    if (dropped) callsByUuid.delete(dropped.callUuid);
  }
}

// ─── Vobiz REST ──────────────────────────────────────────────────────────────
async function vobiz(method, apiPath, body) {
  const url = `${API_BASE}/Account/${AUTH_ID}${apiPath}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Auth-ID': AUTH_ID,
        'X-Auth-Token': AUTH_TOKEN,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await res.text();
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep the raw body */ }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: { error: err.message } };
  }
}

// ─── recording URL signing ───────────────────────────────────────────────────
// A plain <audio> element cannot send an Authorization header, so playback has
// to go through a URL that carries its own proof. It must NOT carry the account
// Auth Token: these links get written into Zendesk ticket comments, where every
// agent on the account can read them forever.
function signRecordingUrl(recordingId) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(`${recordingId}|${exp}`).digest('hex');
  return `${PUBLIC_BASE || ''}/recording-audio/${encodeURIComponent(recordingId)}?exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(recordingId, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(`${recordingId}|${exp}`).digest('hex');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── app ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS scoped to the Zendesk origins this app is actually served from. A
// wildcard here — what this file used to send — lets any page on the internet
// drive the agent's softphone.
//
// The origin that matters is NOT the helpdesk domain. ZAF v2 iframes each app
// from its own *.apps.zdusercontent.com origin, so that is what the panel's
// fetches carry in `Origin`. Allowing only *.zendesk.com fails every preflight
// in production while working fine against zcli locally, which makes it look
// like the backend went down at install time.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.apps\.zdusercontent\.com$/i,
  /^https:\/\/[a-z0-9-]+\.zendesk\.com$/i,
  /^https:\/\/[a-z0-9.-]+\.zdassets\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (EXTRA_ORIGINS.includes(origin) || ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin)))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // ngrok-skip-browser-warning must be listed even though the panel only sends
  // it on ngrok: a header missing from this list fails the CORS preflight, so
  // the browser never sends the real request — an OPTIONS 204 with no GET.
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ══ Webhooks Vobiz calls ═════════════════════════════════════════════════════
// Declared first, and never behind requireSession: Vobiz has no session.

/**
 * The answer URL of the Vobiz application the agent's SIP endpoint is bound to.
 * One handler serves both directions; which one it is is decided by who the
 * call is *from*.
 */
function handleAnswer(req, res) {
  const p = { ...req.query, ...req.body };
  log(`WEBHOOK ${req.method} /answer`, JSON.stringify(p).slice(0, 300));

  res.set('Content-Type', 'text/xml');

  // A Hangup notification is not a request for instructions. Returning <Dial>
  // here hands Vobiz a fresh call leg after the call has already ended.
  if ((p.Event || p.event) === 'Hangup') {
    return res.send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
  }

  const callUuid = String(p.CallUUID || p.call_uuid || '');
  const from = String(p.From || p.from || '');
  const to = String(p.To || p.to || '');
  const routeType = String(p.RouteType || p.routetype || '').toLowerCase();
  const isFromBrowser = from.startsWith('sip:') || routeType === 'sip';

  // action + redirect="false" are both required. Without them Vobiz re-fetches
  // this URL when <Dial> ends and re-executes the whole document, so one call
  // dials the customer over and over.
  const dialStatusUrl = `${PUBLIC_BASE}/dial-status`;
  const recordCallbackUrl = `${PUBLIC_BASE}/recording-ready`;

  // Self-closing <Record> as a SIBLING BEFORE <Dial>, never nested inside it:
  // FreeSWITCH rejects the nested form and the caller hears a bogus "Busy".
  // recordSession="true" captures the bridged audio, and the file is attributed
  // to this A-leg CallUUID.
  const recordXml = `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" redirect="false" callbackUrl="${recordCallbackUrl}" callbackMethod="POST"/>`;

  if (isFromBrowser) {
    // The browser dialled out. `To` is the customer's number.
    const sipUser = (from.match(/^sip:([^@]+)@/) || [])[1] || SIP_USER;
    const sipHeaderCallerId = p['SIPHeader_X-VH-Caller-ID'] || p['SIPHeader_X-PH-Caller-ID'] || p['X-VH-Caller-ID'] || p['X-PH-Caller-ID'] || p.CallerID || p.caller_id;
    const callerId = sipHeaderCallerId || fromBySipUser.get(sipUser) || FROM_NUMBER;
    const destination = to.replace(/[^\d+]/g, '');

    rememberCall({
      callUuid, direction: 'Outbound', agentSipUser: sipUser,
      from: callerId, to: destination, startedAt: Date.now(),
    });

    log(`  -> browser is the A leg, dialling out to ${destination} as ${callerId}`);
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${recordXml}\n` +
      `  <Dial callerId="${callerId}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
      `    <Number>${destination}</Number>\n  </Dial>\n</Response>`
    );
  }

  // A PSTN caller reached our DID. The only way to land that in the browser is
  // <Dial><User>, which is currently blocked platform-side (ISSUES.md #1). The
  // XML below is correct regardless, so inbound starts working the day Vobiz
  // fixes its gateway URI — no change needed here.
  //
  // callerId must be a number this account owns. Omit it and Vobiz derives it
  // from the A leg, which on an inbound call is the *caller's* number — not
  // ours — so B-leg creation is refused silently and totally. Use the DID that
  // was actually dialled, normalised to E.164.
  const callerId = toE164(to) || FROM_NUMBER;
  rememberCall({
    callUuid, direction: 'Inbound', agentSipUser: SIP_USER,
    from, to: callerId, startedAt: Date.now(),
  });

  log(`  -> inbound from ${from}, bridging to sip:${SIP_USER}@${REGISTRAR} callerId=${callerId}`);
  return res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${recordXml}\n` +
    `  <Dial callerId="${callerId}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
    `    <User>sip:${SIP_USER}@${REGISTRAR}</User>\n  </Dial>\n</Response>`
  );
}

// Inbound calls arrive at a different Vobiz application, but the handler is the
// same — it already branches on direction.
app.get('/answer', handleAnswer);
app.post('/answer', handleAnswer);
app.get('/inbound-answer', handleAnswer);
app.post('/inbound-answer', handleAnswer);

function toE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('0') && s.length === 11) return `+91${s.slice(1)}`;
  const digits = s.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * The `action` target of <Dial>. Reporting the result here is what stops the
 * platform replaying the answer document.
 *
 * DialBLegUUID is the single most useful field in this whole stack: empty means
 * no B leg was ever created, whatever the UI says.
 */
function handleDialStatus(req, res) {
  const d = { ...req.query, ...req.body };
  const bleg = d.DialBLegUUID || '';
  log(`DIAL RESULT status=${d.DialStatus || '-'} ring=${d.DialRingStatus || '-'} cause=${d.DialHangupCause || '-'} bleg=${bleg || '(none — B leg never originated)'} dur=${d.DialBLegDuration || '-'}`);

  const rec = callsByUuid.get(String(d.CallUUID || d.call_uuid || ''));
  if (rec) {
    rec.dialStatus = d.DialStatus;
    rec.hangupCause = d.DialHangupCause;
    rec.bLegUuid = bleg || null;
    rec.duration = Number(d.DialBLegDuration || 0);
    rec.endedAt = Date.now();
  }

  if (d.DialStatus === 'failed' && !bleg) {
    log('  ⚠  failed with no B leg — the destination was unreachable, or the callerId is not owned by this account.');
  }
  res.status(200).end();
}
app.get('/dial-status', handleDialStatus);
app.post('/dial-status', handleDialStatus);

/**
 * <Record callbackUrl>. Fires when the file is actually downloadable — this is
 * the real signal, not a poll after the call ends.
 */
function handleRecordingReady(req, res) {
  const d = { ...req.query, ...req.body };
  const callUuid = String(d.CallUUID || d.call_uuid || '');
  log(`RECORDING READY call=${callUuid} id=${d.RecordingID || d.RecordingId || '-'} reason=${d.RecordingEndReason || '-'}`);
  const rec = callsByUuid.get(callUuid);
  if (rec) {
    rec.recordingId = d.RecordingID || d.RecordingId || d.recording_id || null;
    rec.recordingDuration = Number(d.RecordingDuration || 0);
  }
  res.status(200).end();
}
app.get('/recording-ready', handleRecordingReady);
app.post('/recording-ready', handleRecordingReady);

// ══ Endpoints the browser calls ══════════════════════════════════════════════

app.post('/login', async (req, res) => {
  const { agentId, authId, authToken } = req.body || {};
  if (!agentId || !authId || !authToken) {
    return res.status(400).json({ error: 'agentId, authId and authToken are all required' });
  }
  // Accounts are not interchangeable. The SIP endpoint this backend bridges to
  // and the caller ID it dials from both belong to one account, and Vobiz
  // rejects a `from` number the account does not own. Name the mismatch rather
  // than leaving the agent guessing which of several Auth IDs is the right one.
  if (authId !== AUTH_ID || authToken !== AUTH_TOKEN) {
    log(`login rejected — got ${authId}, this backend is bound to ${AUTH_ID}`);
    return res.status(401).json({
      error: `This backend is bound to account ${AUTH_ID}. You signed in as ${authId}, which does not own the SIP endpoint or the caller ID configured here.`,
    });
  }

  // Numbers live at the lowercase /numbers path. /Number/ returns a bare 401
  // that reads exactly like a credentials problem and is not one.
  const r = await vobiz('GET', '/numbers?per_page=25');
  if (r.status >= 400) {
    log('login: numbers lookup failed', r.status);
    return res.status(r.status).json({ error: `Vobiz returned ${r.status} fetching account numbers` });
  }
  const numbers = ((r.body && r.body.objects) || (r.body && r.body.items) || [])
    .map(n => n.e164 || n.number || n.phone_number)
    .filter(Boolean);
  if (FROM_NUMBER && !numbers.includes(FROM_NUMBER)) numbers.unshift(FROM_NUMBER);

  const token = newSession(agentId, authId, numbers, FROM_NUMBER);
  if (SIP_USER) fromBySipUser.set(SIP_USER, FROM_NUMBER);
  log(`login ok — ${agentId}, ${numbers.length} number(s)`);
  res.json({ token, numbers, selected: FROM_NUMBER, authId });
});

app.get('/session', (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, agentId: s.agentId, authId: s.authId, numbers: s.numbers, from: s.from });
});

app.get('/session/:agentId', (req, res) => {
  const targetAgentId = req.params.agentId;
  for (const s of sessions.values()) {
    if (s.agentId === targetAgentId && (Date.now() - s.createdAt <= SESSION_TTL_MS)) {
      return res.json({ loggedIn: true, agentId: s.agentId, authId: s.authId, numbers: s.numbers, from: s.from });
    }
  }
  const s = getSession(req);
  if (s) return res.json({ loggedIn: true, agentId: s.agentId, authId: s.authId, numbers: s.numbers, from: s.from });
  res.json({ loggedIn: false });
});

app.post('/logout', (req, res) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) sessions.delete(header.slice(7));
  res.json({ ok: true });
});

app.post('/login-sip', (req, res) => {
  const { sipUser, callerId } = req.body || {};
  if (!sipUser || !callerId) {
    return res.status(400).json({ error: 'sipUser and callerId are required' });
  }
  const cleanUser = String(sipUser).replace(/^sip:/, '').split('@')[0];
  fromBySipUser.set(cleanUser, callerId);
  log(`SIP direct login registered: ${cleanUser} -> ${callerId}`);
  res.json({ ok: true, sipUser: cleanUser, callerId });
});

app.post('/select-number', requireSession, (req, res) => {
  const { number } = req.body || {};
  const s = req.session;
  if (!s.numbers.includes(number)) return res.status(400).json({ error: 'That number is not on this account' });
  s.from = number;
  if (SIP_USER) fromBySipUser.set(SIP_USER, number);
  log(`caller ID for ${s.agentId} -> ${number}`);
  res.json({ selected: number });
});

function getAgentResponse(agentId) {
  const effectiveAgentId = agentId || 'agent';
  const effectiveSipUser = SIP_USER || (effectiveAgentId.includes('@') ? effectiveAgentId : `${effectiveAgentId}@${REGISTRAR}`);
  const fullSipUser = effectiveSipUser.includes('@') ? effectiveSipUser : `${effectiveSipUser}@${REGISTRAR}`;
  return {
    displayName: `${effectiveAgentId} (Vobiz)`,
    sipUser: fullSipUser,
    registrarUrl: `wss://${REGISTRAR}:5063/`,
    sipPassword: SIP_PASSWORD || '',
  };
}

app.get('/agent/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  res.json(getAgentResponse(agentId));
});

app.get('/agent', (req, res) => {
  const s = getSession(req);
  const agentId = s ? s.agentId : 'agent';
  res.json(getAgentResponse(agentId));
});

app.get('/numbers', requireSession, (req, res) => {
  res.json({ numbers: req.session.numbers, selected: req.session.from });
});

/**
 * What the panel asks for after a call ends, to build the ticket log entry.
 *
 * Vobiz writes the CDR a few seconds after hangup and the recording callback
 * lands later still, so the panel polls this briefly rather than expecting it
 * to be complete the instant the session ends.
 */
app.get('/call-record', (req, res) => {
  const wanted = String(req.query.to || '').replace(/[^\d+]/g, '');
  const rec = recentCalls.find(c => !wanted || String(c.to).replace(/[^\d+]/g, '').endsWith(wanted.slice(-10)));
  if (!rec) return res.json({ found: false });
  res.json({
    found: true,
    callUuid: rec.callUuid,
    direction: rec.direction,
    from: rec.from,
    to: rec.to,
    duration: rec.duration || 0,
    dialStatus: rec.dialStatus || null,
    bLegUuid: rec.bLegUuid || null,
    recordingId: rec.recordingId || null,
    recordingUrl: `${PUBLIC_BASE}/play-recording?callUuid=${rec.callUuid}`,
  });
});

app.get('/recordings', requireSession, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 15), 50);
  const r = await vobiz('GET', `/Recording/?limit=${limit}`);
  const objects = ((r.body && r.body.objects) || []).map(o => ({
    recording_id: o.recording_id,
    add_time: o.add_time,
    rounded_recording_duration: o.rounded_recording_duration,
    call_uuid: o.call_uuid,
    playUrl: signRecordingUrl(o.recording_id),
  }));
  res.json({ objects });
});

app.get('/recordings/:agentId', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 15), 50);
  const r = await vobiz('GET', `/Recording/?limit=${limit}`);
  const objects = ((r.body && r.body.objects) || []).map(o => ({
    recording_id: o.recording_id,
    add_time: o.add_time,
    rounded_recording_duration: o.rounded_recording_duration,
    call_uuid: o.call_uuid,
    playUrl: signRecordingUrl(o.recording_id),
  }));
  res.json({ objects });
});

/**
 * Playback. Signature-gated, not session-gated: an <audio> element cannot send
 * an Authorization header, so the proof has to travel in the URL — but as a
 * short-lived HMAC over this one recording id, never as account credentials.
 */
async function streamAudioToClient(targetUrl, res) {
  try {
    log(`Streaming recording audio from: ${targetUrl}`);
    const audio = await fetch(targetUrl, {
      headers: { 'X-Auth-ID': AUTH_ID, 'X-Auth-Token': AUTH_TOKEN }
    });
    if (!audio.ok) {
      log('Upstream audio fetch failed HTTP', audio.status);
      return res.status(audio.status).json({ error: `Vobiz returned ${audio.status} fetching recording audio` });
    }
    res.set('Content-Type', audio.headers.get('content-type') || 'audio/mpeg');
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Disposition', 'inline; filename="recording.mp3"');
    const buf = Buffer.from(await audio.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    log('recording stream failed:', err.message);
    return res.status(502).json({ error: `Could not stream recording: ${err.message}` });
  }
}

/**
 * GET /play-recording
 * Zero-auth proxy endpoint for playing recordings in Zendesk tickets and in the panel.
 */
app.get('/play-recording', async (req, res) => {
  const callUuid = req.query.callUuid || req.query.call_uuid;
  const recordingId = req.query.recordingId || req.query.recording_id || req.query.id;

  log(`GET /play-recording callUuid=${callUuid || '-'} recordingId=${recordingId || '-'}`);

  try {
    let targetAudioUrl = null;

    // 1. Direct recordingId
    if (recordingId) {
      const meta = await vobiz('GET', `/Recording/${encodeURIComponent(recordingId)}/`);
      targetAudioUrl = meta.body && (meta.body.recording_url || meta.body.url || meta.body.file);
    }

    // 2. Query by callUuid
    if (!targetAudioUrl && callUuid) {
      const recList = await vobiz('GET', `/Recording/?call_uuid=${encodeURIComponent(callUuid)}`);
      const items = (recList.body && (recList.body.objects || recList.body.items)) || [];
      if (items.length > 0) {
        targetAudioUrl = items[0].recording_url || items[0].url || items[0].file;
      }
      if (!targetAudioUrl) {
        const localRec = callsByUuid.get(callUuid);
        if (localRec && localRec.recordingId) {
          const m = await vobiz('GET', `/Recording/${encodeURIComponent(localRec.recordingId)}/`);
          targetAudioUrl = m.body && (m.body.recording_url || m.body.url || m.body.file);
        }
      }
    }

    // 3. Fallback to latest recording
    if (!targetAudioUrl && !callUuid && !recordingId) {
      const recList = await vobiz('GET', '/Recording/?limit=1');
      const items = (recList.body && (recList.body.objects || recList.body.items)) || [];
      if (items.length > 0) {
        targetAudioUrl = items[0].recording_url || items[0].url || items[0].file;
      }
    }

    if (!targetAudioUrl) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Vobiz Call Recording</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); max-width: 460px; text-align: center; border: 1px solid #e2e8f0; }
            .icon { font-size: 44px; margin-bottom: 12px; }
            h2 { margin: 0 0 10px 0; color: #0f172a; font-size: 19px; font-weight: 600; }
            p { margin: 0 0 18px 0; color: #64748b; font-size: 13.5px; line-height: 1.5; }
            .badge { display: inline-block; background: #f1f5f9; color: #334155; padding: 6px 12px; border-radius: 6px; font-size: 11.5px; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">🎙️</div>
            <h2>No Recording File Available</h2>
            <p>Recording is still processing or duration was 0s.</p>
            <div class="badge">Call UUID: ${callUuid || 'N/A'}</div>
          </div>
        </body>
        </html>
      `);
    }

    return await streamAudioToClient(targetAudioUrl, res);
  } catch (err) {
    log('play-recording error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/recording-audio/:recordingId', async (req, res) => {
  const { recordingId } = req.params;
  const meta = await vobiz('GET', `/Recording/${encodeURIComponent(recordingId)}/`);
  const src = meta.body && (meta.body.recording_url || meta.body.url);
  if (!src) return res.status(404).json({ error: 'No audio available for that recording.' });
  return await streamAudioToClient(src, res);
});

app.get('/recording-audio/:agentId/:recordingId', async (req, res) => {
  const { recordingId } = req.params;
  const meta = await vobiz('GET', `/Recording/${encodeURIComponent(recordingId)}/`);
  const src = meta.body && (meta.body.recording_url || meta.body.url);
  if (!src) return res.status(404).json({ error: 'No audio available for that recording.' });
  return await streamAudioToClient(src, res);
});

/**
 * Bind this backend's /answer to the agent's SIP endpoint.
 *
 * Two undocumented things here, both from the README:
 *  - POST /Endpoint/ REWRITES the username you submit, so the stored one must
 *    be read back. We do not create endpoints — we only verify the configured
 *    one exists, so a rewrite mismatch shows up as a clear error.
 *  - POST /Endpoint/{id}/ ignores the documented `application` field and still
 *    returns 202 "changed". The field that works is `app_id`.
 */
async function bindEndpointToApp() {
  if (!PUBLIC_BASE || !PUBLIC_BASE.startsWith('https://')) {
    log('⚠ PUBLIC_BASE must be a public https URL that Vobiz can reach');
    return null;
  }

  const answerUrl = `${PUBLIC_BASE}/answer`;
  const appsRes = await vobiz('GET', '/Application/?limit=50');
  const existing = ((appsRes.body && appsRes.body.objects) || [])
    .find(a => a.answer_url === answerUrl);

  let appId = existing && (existing.app_id || existing.id);
  if (!appId) {
    const created = await vobiz('POST', '/Application/', {
      app_name: 'Zendesk Calling (Vobiz)',
      answer_url: answerUrl, answer_method: 'POST',
      hangup_url: answerUrl, hangup_method: 'POST',
    });
    if (created.status >= 400) {
      log('✖ Could not create Vobiz application:', JSON.stringify(created.body).slice(0, 200));
      return null;
    }
    appId = created.body && (created.body.app_id || created.body.id);
  }
  if (!appId) {
    log('✖ Vobiz did not return an app_id for the application');
    return null;
  }

  const epRes = await vobiz('GET', '/Endpoint/?limit=100');
  const endpoint = ((epRes.body && epRes.body.objects) || []).find(e => e.username === SIP_USER);
  if (!endpoint) {
    log(`✖ No SIP endpoint named "${SIP_USER}" on this account.`);
    return null;
  }

  const bind = await vobiz('POST', `/Endpoint/${encodeURIComponent(endpoint.endpoint_id || endpoint.id)}/`, { app_id: appId });
  if (bind.status >= 400) {
    log('✖ Could not bind endpoint to app:', JSON.stringify(bind.body).slice(0, 200));
    return null;
  }

  log(`✓ setup ok — endpoint ${SIP_USER} bound to app ${appId} (${answerUrl})`);

  if (FROM_NUMBER) {
    try {
      const cleanNum = FROM_NUMBER.replace(/[^\d+]/g, '');
      const numRes = await vobiz('POST', `/Number/${encodeURIComponent(cleanNum)}/`, { app_id: appId });
      log(`number ${cleanNum} bound to app ${appId}: status ${numRes.status}`);
    } catch (e) {
      log(`note binding number: ${e.message}`);
    }
  }

  return { appId, answerUrl };
}

async function handleSetup(req, res) {
  const result = await bindEndpointToApp();
  if (!result) return res.status(500).json({ error: 'Failed to bind endpoint to Vobiz application' });
  const fromNum = (req.session && req.session.from) || FROM_NUMBER;
  res.json({ ok: true, appId: result.appId, answerUrl: result.answerUrl, sipUser: SIP_USER, number: fromNum });
}

app.post('/setup', requireSession, handleSetup);
app.post('/setup-inbound', requireSession, handleSetup);

// ══ Zendesk write-back ═══════════════════════════════════════════════════════

app.post('/sync-call', requireSession, async (req, res) => {
  try {
    const {
      subdomain = ZENDESK_SUBDOMAIN,
      email = ZENDESK_EMAIL,
      apiToken = ZENDESK_API_TOKEN,
      ticketId, toNumber, duration, callDirection, notes, requesterId, callUuid,
    } = req.body || {};

    if (!subdomain) {
      return res.status(400).json({ error: 'No Zendesk subdomain. Set ZENDESK_SUBDOMAIN in the backend .env, or send it in the request.' });
    }

    // The recording link is minted here, server-side, from the call ledger —
    // never taken from the browser and never carrying account credentials.
    const rec = callUuid ? callsByUuid.get(callUuid) : null;
    const recordingUrl = callUuid ? `${PUBLIC_BASE}/play-recording?callUuid=${encodeURIComponent(callUuid)}` : (rec && rec.recordingId ? signRecordingUrl(rec.recordingId) : '');

    log(`sync-call ticket=${ticketId || 'NEW'} dir=${callDirection} dur=${duration}s recording=${recordingUrl ? 'yes' : 'none'}`);

    const result = await syncCallToZendesk({
      subdomain, email, apiToken, ticketId,
      fromNumber: (rec && rec.from) || req.session.from,
      toNumber: toNumber || (rec && rec.to),
      duration, recordingUrl, callDirection, notes, requesterId,
    });
    res.json(result);
  } catch (err) {
    log('sync-call failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/transcription-ready', async (req, res) => {
  try {
    const {
      subdomain = ZENDESK_SUBDOMAIN, email = ZENDESK_EMAIL, apiToken = ZENDESK_API_TOKEN,
      ticketId, transcript, callId,
    } = req.body || {};
    if (!subdomain || !ticketId || !transcript) {
      return res.status(400).json({ error: 'subdomain, ticketId and transcript are all required' });
    }
    res.json(await appendTranscription({ subdomain, email, apiToken, ticketId, transcript, callId }));
  } catch (err) {
    log('transcription append failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    account: AUTH_ID || null,
    from: FROM_NUMBER || null,
    sip: SIP_USER ? `sip:${SIP_USER}@${REGISTRAR}` : null,
    publicBase: PUBLIC_BASE || null,
    zendeskSubdomain: ZENDESK_SUBDOMAIN || null,
    sessions: sessions.size,
    recentCalls: recentCalls.length,
  });
});

app.use((req, res) => {
  log(`404 ${req.method} ${req.path}`);
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  bindEndpointToApp().catch(e => log('Auto-bind error:', e.message));
  console.log(`Vobiz Zendesk calling backend on http://localhost:${PORT}`);
  console.log(`  account     ${AUTH_ID || '(unset)'}`);
  console.log(`  caller ID   ${FROM_NUMBER || '(unset)'}`);
  console.log(`  registers   sip:${SIP_USER || '(unset)'}@${REGISTRAR}`);
  console.log(`  public base ${PUBLIC_BASE || '(NOT SET — Vobiz cannot reach the answer URL, calls will die)'}`);
  console.log(`  zendesk     ${ZENDESK_SUBDOMAIN || '(unset — ticket sync disabled)'}`);
});
