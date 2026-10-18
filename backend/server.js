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
 * INVITE ("tr_eval_uri(): invalid uri", "blocking gw"). See docs/architecture.md.
 *
 * Any Vobiz account can sign in. Nothing account-specific lives in .env: the
 * agent types an Auth ID and Auth Token, this service checks them against
 * Vobiz, and provisions what it needs inside THAT account (one application,
 * one SIP endpoint per agent). See docs/architecture.md.
 *
 * Contract and rationale: docs/architecture.md and docs/backend-contract.md.
 */
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();

const { syncCallToZendesk, appendTranscription } = require('./zendeskService');

// ─── config (deployment only — no Vobiz account values) ─────────────────────
const PORT = Number(process.env.PORT || 8092);
const REGISTRAR = process.env.VOBIZ_REGISTRAR || 'registrar.vobiz.ai';
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');
// Where the authId:agentId -> endpoint map is kept. Ids and usernames only:
// never a password or a token.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

// Used to sign recording URLs. Regenerated on restart if unset, which only
// means previously-issued playback links stop working — never a security hole.
const SIGNING_SECRET = process.env.SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
const RECORDING_URL_TTL_SECONDS = Number(process.env.RECORDING_URL_TTL_SECONDS || 300);
// Links written into ticket comments outlive the panel's short-lived ones: an
// agent opens the ticket days later. Still signed and still expiring.
const TICKET_RECORDING_LINK_TTL_SECONDS = Number(process.env.TICKET_RECORDING_LINK_TTL_SECONDS || 7 * 24 * 3600);
// Shared secret for the optional /transcription-ready webhook. Unset = route off.
const TRANSCRIPTION_WEBHOOK_SECRET = process.env.TRANSCRIPTION_WEBHOOK_SECRET || '';

const API_BASE = 'https://api.vobiz.ai/api/v1';
const APP_NAME = 'Zendesk-Calling-Vobiz';

// ─── input hygiene ───────────────────────────────────────────────────────────
// Everything interpolated into VobizXML goes through xmlEscape. A caller ID that
// reached the XML raw could close the <Dial> and open a new one to any number
// the attacker likes, on the account's balance.
function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
const PHONE_RE = /^\+?\d{6,15}$/;
function cleanPhone(raw) {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  return PHONE_RE.test(s) ? s : '';
}
const digitsOf = n => String(n || '').replace(/\D/g, '');
const AUTH_ID_RE = /^[A-Za-z0-9_]{4,64}$/;
const ID_RE = /^\d+$/;
const E164_STRICT = /^\+?\d{10,15}$/;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ─── state ───────────────────────────────────────────────────────────────────
// authId -> { authId, authToken, numbers, appId }
//
// The account Auth Token lives here, in memory, and nowhere else: never in a
// response, never in a log line, never on disk. A restart forgets it, and the
// agent signs in again.
const accounts = new Map();
// session token -> { agentId, authId, numbers, from, sipUser, sipPassword, endpointId, createdAt }
const sessions = new Map();
// SIP username -> { authId, agentId, callerId }. The /answer webhook has no
// session (it is Vobiz calling us), so this is how it learns which account and
// which caller ID a browser-originated call belongs to.
const sipUsers = new Map();
// SIP-direct sign-ins: SIP username -> { callerId, inboundNumber, at }. No
// account credentials are involved, so this backend knows only what the agent
// typed; Vobiz enforces that the caller ID belongs to the endpoint's account.
const sipDirect = new Map();
// A-leg CallUUID -> call record. Recordings are attributed to the A-leg UUID,
// which is what makes this the right key for both the dial result and the file.
const callsByUuid = new Map();
const recentCalls = [];   // newest first, capped

// authId:agentId -> the caller ID that agent last picked (in memory).
const lastCallerId = new Map();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj && obj[k]).map(k => [k, obj[k]]));

function newSession(fields) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...fields, createdAt: Date.now() });
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

function liveSessions() {
  const now = Date.now();
  const out = [];
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); continue; }
    out.push(s);
  }
  return out;
}

function rememberCall(record) {
  callsByUuid.set(record.callUuid, record);
  recentCalls.unshift(record);
  while (recentCalls.length > 200) {
    const dropped = recentCalls.pop();
    if (dropped) callsByUuid.delete(dropped.callUuid);
  }
}

// ─── endpoint map on disk ────────────────────────────────────────────────────
// { "<authId>:<agentId>": { endpointId, username } } — ids only, mode 0600.
const ENDPOINTS_FILE = path.join(DATA_DIR, 'endpoints.json');

function readEndpointMap() {
  try { return JSON.parse(fs.readFileSync(ENDPOINTS_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeEndpointMap(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${ENDPOINTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ENDPOINTS_FILE);
  try { fs.chmodSync(ENDPOINTS_FILE, 0o600); } catch { /* best effort */ }
}

// ─── Vobiz REST ──────────────────────────────────────────────────────────────
// Vobiz app ids are 17 digits — above Number.MAX_SAFE_INTEGER. JSON.parse turns
// an unquoted one into a different number, so id fields are quoted in the raw
// text BEFORE parsing, and every id stays a string from then on.
function parseVobizJson(raw) {
  const quoted = String(raw).replace(/"(app_id|application_id|endpoint_id|application|id)"\s*:\s*(\d+)/g, '"$1":"$2"');
  try { return JSON.parse(quoted); } catch { return raw; }
}

/**
 * One Vobiz REST call as one account. `rawBody` is sent verbatim when it is a
 * string (so an id can be spliced in as an integer literal without ever being a
 * JS number); an object is JSON-encoded.
 */
async function vobiz(account, method, apiPath, rawBody) {
  const url = `${API_BASE}/Account/${encodeURIComponent(account.authId)}${apiPath}`;
  const body = rawBody === undefined ? undefined : (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Auth-ID': account.authId,
        'X-Auth-Token': account.authToken,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    const raw = await res.text();
    return { status: res.status, body: parseVobizJson(raw), raw };
  } catch (err) {
    return { status: 0, body: { error: err.message }, raw: '' };
  }
}

const listOf = r => (r && r.body && (r.body.objects || r.body.items)) || [];
const ok = r => r.status >= 200 && r.status < 300;

/**
 * Every number on the account, from List Account Phone Numbers
 * (GET /numbers?page=N&per_page=100 -> { items, page, per_page, total }),
 * paged until `total` are loaded. The first page doubles as the credential
 * check: a non-2xx there is returned as { status } with no list.
 *
 * Returns { status, all, callerIds, apps }: `all` is every e164 (used to route
 * inbound calls), `callerIds` the ones usable as a caller ID (status "active"
 * and voice_enabled not false), `apps` e164 -> the application_id it is on now.
 */
async function fetchAccountNumbers(account) {
  const items = [];
  let status = 0;
  for (let page = 1; page <= 50; page++) {
    const r = await vobiz(account, 'GET', `/numbers?page=${page}&per_page=100`);
    status = r.status;
    if (!ok(r)) return { status };
    const batch = listOf(r);
    items.push(...batch);
    const total = Number(r.body && r.body.total);
    if (!batch.length || (Number.isFinite(total) ? items.length >= total : batch.length < 100)) break;
  }
  const all = [];
  const callerIds = [];
  const apps = {};
  for (const n of items) {
    const e164 = String(n.e164 || n.number || n.phone_number || '');
    if (!cleanPhone(e164)) continue;
    all.push(e164);
    if (n.application_id) apps[e164] = String(n.application_id);
    const active = n.status === undefined || n.status === 'active';
    if (active && n.voice_enabled !== false && !callerIds.includes(e164)) callerIds.push(e164);
  }
  return { status, all, callerIds, apps };
}

// ─── per-sign-in provisioning ────────────────────────────────────────────────

/**
 * Find this integration's application in the account, or create it. Matched on
 * answer_url only, so an application someone else built is never repointed.
 */
async function ensureApplication(account) {
  if (account.appId) return account.appId;
  const answerUrl = `${PUBLIC_BASE}/answer`;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await vobiz(account, 'GET', `/Application/?limit=100&offset=${offset}`);
    if (!ok(page)) break;
    const items = listOf(page);
    const hit = items.find(a => a.answer_url === answerUrl);
    if (hit && ID_RE.test(String(hit.app_id || ''))) {
      account.appId = String(hit.app_id);
      return account.appId;
    }
    if (items.length < 100) break;
  }
  const created = await vobiz(account, 'POST', '/Application/', {
    // Documented rule: letters, digits, '-' and '_'.
    app_name: APP_NAME,
    answer_url: answerUrl, answer_method: 'POST',
    hangup_url: answerUrl, hangup_method: 'POST',
  });
  const appId = created.body && created.body.app_id ? String(created.body.app_id) : '';
  if (!ok(created) || !ID_RE.test(appId)) {
    log(`✖ ${account.authId}: could not create the Vobiz application (HTTP ${created.status})`);
    return null;
  }
  log(`${account.authId}: created application ${appId} -> ${answerUrl}`);
  account.appId = appId;
  return appId;
}

function randomSipPassword() {
  return `Vz${crypto.randomBytes(18).toString('base64url')}`;
}

/**
 * One endpoint per (authId, agentId), created on first sign-in and reused after.
 * Every sign-in rotates its SIP password; the new one goes to that browser
 * session only and is never written down.
 */
async function ensureEndpoint(account, agentId) {
  const key = `${account.authId}:${agentId}`;
  const map = readEndpointMap();
  const password = randomSipPassword();
  const known = map[key];

  if (known && known.endpointId) {
    const got = await vobiz(account, 'GET', `/Endpoint/${encodeURIComponent(known.endpointId)}/`);
    if (ok(got)) {
      const reset = await vobiz(account, 'POST', `/Endpoint/${encodeURIComponent(known.endpointId)}/`, { password });
      if (!ok(reset)) {
        log(`✖ ${account.authId}: could not reset the SIP password for endpoint ${known.endpointId} (HTTP ${reset.status})`);
        return null;
      }
      const username = (got.body && got.body.username) || known.username;
      if (username !== known.username) { map[key] = { endpointId: known.endpointId, username }; writeEndpointMap(map); }
      return { endpointId: String(known.endpointId), username, password };
    }
    log(`${account.authId}: stored endpoint ${known.endpointId} for ${agentId} is gone (HTTP ${got.status}); creating a new one`);
  }

  // The alias names this agent exactly, so an endpoint survives a lost data
  // dir: it is found again by alias instead of being created twice.
  const agentPart = String(agentId).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'agent';
  const alias = `Zendesk-${agentPart}-${crypto.createHash('sha256').update(String(agentId)).digest('hex').slice(0, 8)}`;
  if (!known) {
    const list = await vobiz(account, 'GET', '/Endpoint/?limit=100');
    const hit = listOf(list).find(e => e.alias === alias && e.endpoint_id);
    if (hit) {
      const id = String(hit.endpoint_id);
      const reset = await vobiz(account, 'POST', `/Endpoint/${encodeURIComponent(id)}/`, { password });
      if (ok(reset) && hit.username) {
        map[key] = { endpointId: id, username: String(hit.username) };
        writeEndpointMap(map);
        return { endpointId: id, username: String(hit.username), password };
      }
    }
  }

  // Usernames must be alphanumeric. Vobiz rewrites the submitted one anyway, so
  // the stored one is always read back.
  const submitted = `zd${agentPart}${crypto.randomBytes(3).toString('hex')}`;
  const created = await vobiz(account, 'POST', '/Endpoint/', { username: submitted, password, alias });
  const endpointId = created.body && created.body.endpoint_id ? String(created.body.endpoint_id) : '';
  if (!ok(created) || !endpointId) {
    log(`✖ ${account.authId}: endpoint creation failed (HTTP ${created.status})`);
    return null;
  }
  const readBack = await vobiz(account, 'GET', `/Endpoint/${encodeURIComponent(endpointId)}/`);
  const username = (readBack.body && readBack.body.username) || '';
  if (!username) {
    log(`✖ ${account.authId}: could not read back the username of endpoint ${endpointId}`);
    return null;
  }
  if (username !== submitted) log(`${account.authId}: Vobiz stored endpoint username "${username}" (submitted "${submitted}")`);
  map[key] = { endpointId, username };
  writeEndpointMap(map);
  return { endpointId, username, password };
}

// The application id bound to an endpoint, read from the raw response text so a
// 17-digit id is never squeezed through a JS number.
function boundAppId(raw) {
  const m = String(raw || '').match(/"application"\s*:\s*\{[^}]*?"app_id"\s*:\s*"?(\d+)"?/)
    || String(raw || '').match(/"app_id"\s*:\s*"?(\d+)"?/);
  return m ? m[1] : '';
}

/**
 * Bind endpoint -> application. First `{"app_id":"<id>"}` with the id as a
 * string — what the reference WebRTC playground sends, and it works — then a
 * read-back to verify. If it did not take, retry once with the documented
 * `{"application": <integer>}`, the id spliced into the body text as an integer
 * literal so it is never converted to a JS number (17 digits is past
 * Number.MAX_SAFE_INTEGER).
 */
async function bindEndpoint(account, endpointId, appId) {
  if (!ID_RE.test(String(appId))) return false;
  const epPath = `/Endpoint/${encodeURIComponent(endpointId)}/`;
  await vobiz(account, 'POST', epPath, '{"app_id":"' + appId + '"}');
  let check = await vobiz(account, 'GET', epPath);
  if (boundAppId(check.raw) === String(appId)) {
    log(`${account.authId}: endpoint ${endpointId} bound to application ${appId}`);
    return true;
  }
  await vobiz(account, 'POST', epPath, '{"application":' + appId + '}');
  check = await vobiz(account, 'GET', epPath);
  const bound = boundAppId(check.raw) === String(appId);
  log(`${account.authId}: endpoint ${endpointId} ${bound ? 'bound' : 'NOT bound'} to application ${appId} after the documented "application" retry`);
  return bound;
}

// ─── recording URL signing ───────────────────────────────────────────────────
// A plain <audio> element cannot send an Authorization header, so playback has
// to go through a URL that carries its own proof. It must NOT carry the account
// Auth Token: these links get written into Zendesk ticket comments, where every
// agent on the account can read them. The authId is inside the HMAC, so a link
// for one account can never fetch another account's audio.
function hmac(payload) {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
}

function signRecordingUrl(authId, recordingId) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = hmac(`rec|${authId}|${recordingId}|${exp}`);
  return `${PUBLIC_BASE || ''}/recording-audio/${encodeURIComponent(recordingId)}?authId=${encodeURIComponent(authId)}&exp=${exp}&sig=${sig}`;
}

// Ticket links are minted at hangup, before the recording exists, so they name
// the call rather than the file. Domain-separated from recording signatures.
function signCallRecordingUrl(authId, callUuid) {
  const exp = Math.floor(Date.now() / 1000) + TICKET_RECORDING_LINK_TTL_SECONDS;
  const sig = hmac(`call|${authId}|${callUuid}|${exp}`);
  return `${PUBLIC_BASE || ''}/play-recording?authId=${encodeURIComponent(authId)}&callUuid=${encodeURIComponent(callUuid)}&exp=${exp}&sig=${sig}`;
}

function verifyHmac(payload, exp, sig) {
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(String(exp)) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(hmac(payload));
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

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const politeHangup = text =>
  `${XML_HEAD}<Response>\n  <Speak>${xmlEscape(text)}</Speak>\n  <Hangup/>\n</Response>`;

function sipDirectUsersFor(to) {
  const want = digitsOf(to);
  const now = Date.now();
  const out = [];
  for (const [user, d] of sipDirect) {
    if (now - d.at > SESSION_TTL_MS) { sipDirect.delete(user); continue; }
    if (want && digitsOf(d.inboundNumber) === want) out.push(user);
  }
  return out;
}

/**
 * The account a dialled DID belongs to, among accounts that have signed in
 * since this process started.
 */
function accountForNumber(to) {
  const want = digitsOf(to);
  if (!want) return null;
  for (const acct of accounts.values()) {
    if ((acct.numbers || []).some(n => digitsOf(n) === want)) return acct;
  }
  return null;
}

/**
 * The answer URL of this integration's Vobiz application, in every account that
 * signs in. One handler serves both directions; which one it is is decided by
 * who the call is *from*.
 */
function handleAnswer(req, res) {
  const p = { ...req.query, ...req.body };
  log(`WEBHOOK ${req.method} /answer call=${p.CallUUID || p.call_uuid || '-'} from=${p.From || p.from || '-'} to=${p.To || p.to || '-'}`);

  res.set('Content-Type', 'text/xml');

  // A Hangup notification is not a request for instructions. Returning <Dial>
  // here hands Vobiz a fresh call leg after the call has already ended.
  if ((p.Event || p.event) === 'Hangup') {
    return res.send(`${XML_HEAD}<Response></Response>`);
  }

  const callUuid = String(p.CallUUID || p.call_uuid || '');
  const from = String(p.From || p.from || '');
  const to = String(p.To || p.to || '');
  const routeType = String(p.RouteType || p.routetype || '').toLowerCase();
  const isFromBrowser = from.startsWith('sip:') || routeType === 'sip';

  // action + redirect="false" are both required. Without them Vobiz re-fetches
  // this URL when <Dial> ends and re-executes the whole document, so one call
  // dials the customer over and over.
  const dialStatusUrl = xmlEscape(`${PUBLIC_BASE}/dial-status`);
  const recordCallbackUrl = xmlEscape(`${PUBLIC_BASE}/recording-ready`);

  // Self-closing <Record> as a SIBLING BEFORE <Dial>, never nested inside it:
  // FreeSWITCH rejects the nested form and the caller hears a bogus "Busy".
  // recordSession="true" captures the bridged audio, and the file is attributed
  // to this A-leg CallUUID.
  const recordXml = `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" redirect="false" callbackUrl="${recordCallbackUrl}" callbackMethod="POST"/>`;

  if (isFromBrowser) {
    // The browser dialled out. `To` is the customer's number. The SIP username
    // says which agent — and therefore which account and caller ID — it is.
    const sipUser = (from.match(/^sip:([^@]+)@/) || [])[1] || '';
    // Caller ID: the panel names it in the X-VH-Caller-ID SIP header on the
    // INVITE (Vobiz passes X-VH- headers to this webhook as top-level params,
    // sometimes prefixed SIPHeader_), and also tells this backend out of band
    // per SIP user (/select-number, /login-sip). The header wins when valid.
    const rawHeader = String(p['X-VH-Caller-ID'] || p['SIPHeader_X-VH-Caller-ID'] || '').trim();
    const headerCallerId = E164_STRICT.test(rawHeader) ? rawHeader : '';
    let who = sipUsers.get(sipUser);
    if (who) {
      // Account sign-in: only one of that account's own numbers.
      const acct = accounts.get(who.authId);
      if (headerCallerId && acct && (acct.numbers || []).some(n => digitsOf(n) === digitsOf(headerCallerId))) {
        who = { ...who, callerId: headerCallerId };
      }
    } else {
      // SIP direct: no account credentials, so ownership is not checkable here.
      // Vobiz itself refuses a caller ID the endpoint's account does not own.
      const direct = sipDirect.get(sipUser);
      const callerId = headerCallerId || (direct && direct.callerId) || '';
      if (callerId) who = { authId: null, agentId: `sip:${sipUser}`, callerId };
    }
    if (!who) {
      log(`  ✖ outbound from unknown SIP user "${sipUser}" — no signed-in agent; hanging up`);
      return res.send(`${XML_HEAD}<Response><Hangup reason="rejected"/></Response>`);
    }
    const callerId = cleanPhone(who.callerId);
    const destination = cleanPhone(to);
    if (!destination || !callerId) {
      log(`  ✖ refusing to dial: destination="${to}" callerId="${who.callerId}" is not a plain phone number`);
      return res.send(`${XML_HEAD}<Response><Hangup reason="rejected"/></Response>`);
    }

    rememberCall({
      callUuid, authId: who.authId, agentId: who.agentId, direction: 'Outbound', agentSipUser: sipUser,
      from: callerId, to: destination, startedAt: Date.now(),
    });

    log(`  -> ${who.authId || 'SIP direct'}/${who.agentId}: browser is the A leg, dialling out to ${destination} as ${callerId}`);
    return res.send(
      `${XML_HEAD}<Response>\n  ${recordXml}\n` +
      `  <Dial callerId="${xmlEscape(callerId)}" timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
      `    <Number>${xmlEscape(destination)}</Number>\n  </Dial>\n</Response>`
    );
  }

  // A PSTN caller reached a DID. Find whose it is, and ring that account's
  // signed-in agents. <Dial><User> is the only way to land a call in a browser.
  // Which account: the webhook's ParentAuthID names it directly (what the
  // reference WebRTC playground routes on). Only if that is absent, or nobody
  // from it is signed in here, fall back to the account whose number list has
  // the dialled DID, then to SIP-direct agents who named this number.
  const parentAuthId = String(p.ParentAuthID || p.parentauthid || '');
  const byParent = parentAuthId && accounts.get(parentAuthId);
  const acct = (byParent && liveSessions().some(s => s.authId === byParent.authId)) ? byParent : accountForNumber(to);
  const accountUsers = acct ? liveSessions().filter(s => s.authId === acct.authId).map(s => s.sipUser) : [];
  const directUsers = acct ? [] : sipDirectUsersFor(to);
  const agentUsers = [...new Set([...accountUsers, ...directUsers])];
  if (!agentUsers.length) {
    log(`  ✖ inbound to ${to}: ${acct ? `no agent of ${acct.authId} is signed in` : 'no signed-in account or SIP-direct agent has this number'}; hanging up`);
    return res.send(politeHangup('Sorry, no one is available to take your call. Please try again later.'));
  }

  // callerId must be a number this account owns. Omit it and Vobiz derives it
  // from the A leg, which on an inbound call is the *caller's* number — not
  // ours — so B-leg creation is refused silently and totally. Use the DID that
  // was actually dialled, normalised to E.164.
  const callerId = cleanPhone(toE164(to));
  // callerId has to be our DID, so the browser would otherwise see our own
  // number ringing. callerName carries the real caller for the panel's screen pop.
  const callerName = cleanPhone(from);
  rememberCall({
    callUuid, authId: acct ? acct.authId : null, direction: 'Inbound', agentSipUser: agentUsers.join(','),
    from, to: callerId, startedAt: Date.now(),
  });

  log(`  -> inbound from ${from} to ${acct ? acct.authId : 'SIP direct'}, ringing ${agentUsers.length} agent(s) callerId=${callerId}`);
  const users = agentUsers.map(u => `    <User>${xmlEscape(`sip:${u}@${REGISTRAR}`)}</User>`).join('\n');
  return res.send(
    `${XML_HEAD}<Response>\n  ${recordXml}\n` +
    `  <Dial callerId="${xmlEscape(callerId)}"${callerName ? ` callerName="${xmlEscape(callerName)}"` : ''} timeout="30" timeLimit="14400" action="${dialStatusUrl}" method="POST" redirect="false">\n` +
    `${users}\n  </Dial>\n</Response>`
  );
}

// /inbound-answer is kept as an alias for applications set up by older builds.
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

/**
 * Sign in with any Vobiz account. The pair is checked against Vobiz itself;
 * then this integration's application and this agent's SIP endpoint are found
 * or created in that account, and the endpoint gets a fresh SIP password that
 * only this browser session receives.
 */
app.post('/login', async (req, res) => {
  const { agentId, authId, authToken } = req.body || {};
  if (!agentId || !authId || !authToken) {
    return res.status(400).json({ error: 'agentId, authId and authToken are all required' });
  }
  if (!AUTH_ID_RE.test(String(authId)) || typeof authToken !== 'string' || String(agentId).length > 128) {
    return res.status(400).json({ error: 'That does not look like a Vobiz Auth ID.' });
  }
  if (!PUBLIC_BASE || !PUBLIC_BASE.startsWith('https://')) {
    log('⚠ PUBLIC_BASE must be a public https URL that Vobiz can reach');
    return res.status(500).json({ error: 'This backend has no public https PUBLIC_BASE, so Vobiz could not reach it. Set PUBLIC_BASE and restart.' });
  }

  const candidate = { authId: String(authId), authToken };
  // Numbers live at the lowercase /numbers path. /Number/ returns a bare 401
  // that reads exactly like a credentials problem and is not one.
  const list = await fetchAccountNumbers(candidate);
  if (!list.all) {
    log(`login refused for ${authId}: Vobiz returned ${list.status} checking the credentials`);
    return res.status(401).json({ error: 'Vobiz did not accept that Auth ID and Auth Token. Copy both from the Vobiz Console (API credentials) and try again.' });
  }
  // The caller-ID picker offers exactly these; anything else is refused.
  const numbers = list.callerIds;

  // Verified: this token is now the one used for this account.
  const account = accounts.get(candidate.authId) || { authId: candidate.authId };
  account.authToken = authToken;
  account.numbers = list.all;
  account.numberApps = list.apps;
  accounts.set(account.authId, account);

  const appId = await ensureApplication(account);
  if (!appId) return res.status(502).json({ error: 'Could not find or create the Zendesk calling application in your Vobiz account — see the backend log.' });
  const ep = await ensureEndpoint(account, String(agentId));
  if (!ep) return res.status(502).json({ error: 'Could not set up a SIP endpoint for you in your Vobiz account — see the backend log.' });
  const bound = await bindEndpoint(account, ep.endpointId, appId);
  if (!bound) log(`⚠ ${account.authId}: endpoint ${ep.endpointId} is not bound to ${appId}; outbound calls may not reach this backend`);

  // Default: the agent's last choice, if it is still offered; else the first.
  const last = lastCallerId.get(`${account.authId}:${agentId}`);
  const from = numbers.includes(last) ? last : (numbers[0] || '');
  const token = newSession({
    agentId: String(agentId), authId: account.authId, numbers, from,
    sipUser: ep.username, sipPassword: ep.password, endpointId: ep.endpointId,
  });
  sipUsers.set(ep.username, { authId: account.authId, agentId: String(agentId), callerId: from });
  sipDirect.delete(ep.username);
  log(`login ok — ${account.authId}/${agentId} as ${ep.username}, ${numbers.length} number(s)`);
  res.json({ token, numbers, numberApps: pick(list.apps, numbers), selected: from, appId, authId: account.authId, sipUser: ep.username, bound });
});

app.get('/session', (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ loggedIn: false });
  const account = accounts.get(s.authId);
  res.json({
    loggedIn: true, agentId: s.agentId, authId: s.authId, numbers: s.numbers, from: s.from,
    numberApps: pick(account && account.numberApps, s.numbers), appId: (account && account.appId) || null,
  });
});

app.post('/logout', (req, res) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const s = sessions.get(header.slice(7));
    sessions.delete(header.slice(7));
    if (s && !liveSessions().some(o => o.sipUser === s.sipUser)) sipUsers.delete(s.sipUser);
  }
  res.json({ ok: true });
});

/**
 * SIP-direct sign-in. The agent typed an existing endpoint's SIP username and
 * password (the password never comes here — the browser registers with it
 * directly) plus a caller ID. This only records sipUser -> caller ID, which is
 * also the inbound number that rings this agent. No account credentials exist
 * in this mode, so ownership is not checked here: Vobiz itself refuses a
 * caller ID the endpoint's account does not own. The endpoint and the DID must
 * already be on an application whose answer URL is this backend's /answer.
 */
app.post('/login-sip', (req, res) => {
  const { sipUser, callerId } = req.body || {};
  const cleanUser = String(sipUser || '').replace(/^sip:/, '').split('@')[0];
  const cleanCaller = cleanPhone(callerId);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(cleanUser) || !cleanCaller) {
    return res.status(400).json({ error: 'A SIP username and a plain E.164 caller ID are required' });
  }
  // An endpoint this backend provisioned for an account sign-in is routed by
  // that account; a SIP-direct claim must not override it.
  if (sipUsers.has(cleanUser)) {
    return res.status(409).json({ error: 'That endpoint is signed in with a Vobiz account here. Use the Vobiz account tab.' });
  }
  sipDirect.set(cleanUser, { callerId: cleanCaller, inboundNumber: cleanCaller, at: Date.now() });
  log(`SIP direct sign-in: ${cleanUser} -> ${cleanCaller}`);
  res.json({ ok: true, sipUser: cleanUser, callerId: cleanCaller });
});

app.post('/select-number', requireSession, (req, res) => {
  const { number } = req.body || {};
  const s = req.session;
  if (!s.numbers.includes(number)) return res.status(400).json({ error: 'That number is not on this account' });
  s.from = number;
  lastCallerId.set(`${s.authId}:${s.agentId}`, number);
  const who = sipUsers.get(s.sipUser);
  if (who) who.callerId = number;
  log(`caller ID for ${s.authId}/${s.agentId} -> ${number}`);
  res.json({ selected: number });
});

/**
 * The SIP identity the panel registers as: this agent's own endpoint, with the
 * password minted at this sign-in.
 *
 * Behind the session on purpose, and there is deliberately no /agent/:agentId.
 * A route that answers for any id, unauthenticated, hands the live SIP password
 * to anyone who knows the backend URL — that shipped twice already.
 */
app.get('/agent', requireSession, (req, res) => {
  const s = req.session;
  res.json({
    displayName: `${s.agentId} (Vobiz)`,
    sipUser: `${s.sipUser}@${REGISTRAR}`,
    registrarUrl: `wss://${REGISTRAR}:5063/`,
    sipPassword: s.sipPassword,
  });
});

app.get('/numbers', requireSession, (req, res) => {
  const account = accounts.get(req.session.authId);
  res.json({ numbers: req.session.numbers, numberApps: pick(account && account.numberApps, req.session.numbers), selected: req.session.from });
});

/**
 * What the panel asks for after a call ends, to build the ticket log entry.
 * Only this account's calls are ever considered.
 *
 * Vobiz writes the CDR a few seconds after hangup and the recording callback
 * lands later still, so the panel polls this briefly rather than expecting it
 * to be complete the instant the session ends.
 */
app.get('/call-record', requireSession, (req, res) => {
  const wanted = String(req.query.to || '').replace(/[^\d+]/g, '');
  const tail = n => String(n || '').replace(/[^\d+]/g, '').slice(-10);
  const rec = recentCalls.find(c => c.authId === req.session.authId &&
    (!wanted || tail(c.to) === wanted.slice(-10) || tail(c.from) === wanted.slice(-10)));
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
    recordingUrl: rec.callUuid ? signCallRecordingUrl(rec.authId, rec.callUuid) : null,
  });
});

app.get('/recordings', requireSession, async (req, res) => {
  const account = accounts.get(req.session.authId);
  if (!account) return res.status(401).json({ error: 'Sign in again.' });
  const limit = Math.min(Number(req.query.limit || 15), 50);
  const r = await vobiz(account, 'GET', `/Recording/?limit=${limit}`);
  const objects = listOf(r).map(o => ({
    recording_id: o.recording_id,
    add_time: o.add_time,
    rounded_recording_duration: o.rounded_recording_duration,
    call_uuid: o.call_uuid,
    playUrl: signRecordingUrl(account.authId, o.recording_id),
  }));
  res.json({ objects });
});

/**
 * Fetch the audio from Vobiz with the owning account's credentials and stream
 * it back. The source URL always comes from Vobiz's own Recording API — never
 * from the request — so this cannot be pointed at an arbitrary host.
 */
async function streamAudioToClient(account, targetUrl, res) {
  try {
    const audio = await fetch(targetUrl, {
      headers: { 'X-Auth-ID': account.authId, 'X-Auth-Token': account.authToken },
    });
    if (!audio.ok) {
      log('Upstream audio fetch failed HTTP', audio.status);
      return res.status(502).json({ error: `Vobiz returned ${audio.status} fetching recording audio` });
    }
    res.set('Content-Type', audio.headers.get('content-type') || 'audio/mpeg');
    res.set('Content-Disposition', 'inline; filename="recording.mp3"');
    res.set('Cache-Control', 'private, no-store');
    return res.send(Buffer.from(await audio.arrayBuffer()));
  } catch (err) {
    log('recording stream failed:', err.message);
    return res.status(502).json({ error: 'Could not stream that recording.' });
  }
}

function recordingSource(meta) {
  return meta && meta.body && (meta.body.recording_url || meta.body.url || meta.body.file);
}

// The account named in a signed link. After a backend restart nobody's token is
// in memory until someone from that account signs in again.
function accountForLink(authId, res) {
  const account = accounts.get(String(authId));
  if (!account || !account.authToken) {
    res.status(409).json({ error: 'The calling backend restarted since this link was made. Ask someone on this Vobiz account to sign in to the Zendesk calling panel, then open the link again.' });
    return null;
  }
  return account;
}

/**
 * Panel playback. Signature-gated, not session-gated: an <audio> element cannot
 * send an Authorization header, so the proof travels in the URL — as a
 * short-lived HMAC over this account and this recording id, never as account
 * credentials.
 */
app.get('/recording-audio/:recordingId', async (req, res) => {
  const { recordingId } = req.params;
  const authId = String(req.query.authId || '');
  if (!authId || !verifyHmac(`rec|${authId}|${recordingId}|${req.query.exp}`, req.query.exp, req.query.sig)) {
    return res.status(403).json({ error: 'This playback link is invalid or has expired. Reload the panel to get a fresh one.' });
  }
  const account = accountForLink(authId, res);
  if (!account) return;
  const src = recordingSource(await vobiz(account, 'GET', `/Recording/${encodeURIComponent(recordingId)}/`));
  if (!src) return res.status(404).json({ error: 'No audio is available for that recording yet.' });
  return streamAudioToClient(account, src, res);
});

/**
 * Ticket playback. The link in the ticket comment is signed over the account
 * and the call UUID (the recording does not exist yet when the comment is
 * written) and expires after TICKET_RECORDING_LINK_TTL_SECONDS.
 */
app.get('/play-recording', async (req, res) => {
  const callUuid = String(req.query.callUuid || '');
  const authId = String(req.query.authId || '');
  if (!callUuid || !authId || !verifyHmac(`call|${authId}|${callUuid}|${req.query.exp}`, req.query.exp, req.query.sig)) {
    return res.status(403).json({ error: 'This recording link is invalid or has expired.' });
  }
  const account = accountForLink(authId, res);
  if (!account) return;

  let src = null;
  const local = callsByUuid.get(callUuid);
  if (local && local.authId === authId && local.recordingId) {
    src = recordingSource(await vobiz(account, 'GET', `/Recording/${encodeURIComponent(local.recordingId)}/`));
  }
  if (!src) {
    // Only accept a recording whose call_uuid actually matches. If the filter
    // is ignored upstream, items[0] would be some other caller's conversation.
    const list = await vobiz(account, 'GET', `/Recording/?call_uuid=${encodeURIComponent(callUuid)}`);
    const match = listOf(list).find(o => o.call_uuid === callUuid);
    if (match) src = match.recording_url || match.url || match.file || null;
  }
  if (!src) return res.status(404).json({ error: 'The recording is still processing, or this call was not recorded.' });
  return streamAudioToClient(account, src, res);
});

/**
 * "Enable inbound calls": attach the agent's selected number to this
 * integration's application. This MOVES the number off whatever application it
 * was on, which is why it never happens at sign-in — only on this explicit step.
 */
app.post('/setup-inbound', requireSession, async (req, res) => {
  const s = req.session;
  const account = accounts.get(s.authId);
  if (!account) return res.status(401).json({ error: 'Sign in again.' });
  const number = cleanPhone(s.from);
  if (!number || !s.numbers.includes(s.from)) return res.status(400).json({ error: 'Pick one of your Vobiz numbers as the caller ID first.' });
  const appId = await ensureApplication(account);
  if (!appId) return res.status(502).json({ error: 'Could not find or create the Zendesk calling application — see the backend log.' });
  const previousAppId = (account.numberApps && account.numberApps[s.from]) || null;
  const e164 = `%2B${digitsOf(number)}`;
  const r = await vobiz(account, 'POST', `/numbers/${e164}/application`, '{"application_id":"' + appId + '"}');
  log(`${account.authId}: attach ${number} to application ${appId} (was ${previousAppId || 'none'}): HTTP ${r.status}`);
  if (!ok(r)) return res.status(502).json({ error: `Vobiz returned ${r.status} attaching ${number}` });
  if (!account.numberApps) account.numberApps = {};
  account.numberApps[s.from] = appId;
  const moved = previousAppId && previousAppId !== appId ? ` It was moved off application ${previousAppId}.` : '';
  res.json({ ok: true, appId, previousAppId, number, message: `Inbound calls to ${number} now ring this panel.${moved}` });
});

// ══ Zendesk write-back ═══════════════════════════════════════════════════════

// Zendesk credentials come from .env and nowhere else. Accepting a subdomain,
// email or token from the request body let a caller aim this server's Zendesk
// API token at a host of their choosing: `subdomain: "evil.example/x?"` builds
// https://evil.example/x?.zendesk.com/... with the Authorization header attached.
function zendeskConfig() {
  if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_API_TOKEN) return null;
  return { subdomain: ZENDESK_SUBDOMAIN, email: ZENDESK_EMAIL, apiToken: ZENDESK_API_TOKEN };
}

app.post('/sync-call', requireSession, async (req, res) => {
  try {
    const zd = zendeskConfig();
    if (!zd) {
      // The panel falls back to writing through the agent's own Zendesk session.
      return res.status(400).json({ error: 'Backend ticket sync is off: set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL and ZENDESK_API_TOKEN in backend/.env.' });
    }
    const { ticketId, toNumber, duration, callDirection, notes, requesterId, callUuid } = req.body || {};

    // The recording link is minted here, server-side, from the call ledger —
    // signed, expiring, and never carrying account credentials.
    // Only a call from the agent's own account: a callUuid from another account
    // must not mint a link to that account's recording.
    const found = callUuid ? callsByUuid.get(String(callUuid)) : null;
    const rec = found && found.authId === req.session.authId ? found : null;
    const recordingUrl = rec ? signCallRecordingUrl(rec.authId, rec.callUuid) : '';

    log(`sync-call ticket=${ticketId || 'NEW'} dir=${callDirection} dur=${duration}s recording=${recordingUrl ? 'yes' : 'none'}`);

    const result = await syncCallToZendesk({
      ...zd, ticketId,
      fromNumber: (rec && rec.from) || req.session.from,
      toNumber: toNumber || (rec && rec.to),
      duration, recordingUrl, callDirection, notes, requesterId,
    });
    res.json(result);
  } catch (err) {
    log('sync-call failed:', err.message);
    res.status(500).json({ error: 'Could not write the call to Zendesk — see the backend log.' });
  }
});

/**
 * Optional webhook for a transcription service. Off unless
 * TRANSCRIPTION_WEBHOOK_SECRET is set; the caller must send it as a Bearer token.
 */
app.post('/transcription-ready', async (req, res) => {
  if (!TRANSCRIPTION_WEBHOOK_SECRET) return res.status(404).json({ error: 'Transcription webhook is not enabled' });
  const header = String(req.headers.authorization || '');
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(TRANSCRIPTION_WEBHOOK_SECRET);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const zd = zendeskConfig();
  if (!zd) return res.status(400).json({ error: 'Zendesk credentials are not configured in backend/.env' });
  try {
    const { ticketId, transcript, callId } = req.body || {};
    if (!/^\d+$/.test(String(ticketId || '')) || !transcript) {
      return res.status(400).json({ error: 'A numeric ticketId and a transcript are required' });
    }
    res.json(await appendTranscription({ ...zd, ticketId, transcript, callId }));
  } catch (err) {
    log('transcription append failed:', err.message);
    res.status(500).json({ error: 'Could not append the transcript — see the backend log.' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    publicBase: PUBLIC_BASE || null,
    zendeskSubdomain: ZENDESK_SUBDOMAIN || null,
    accounts: accounts.size,
    sessions: sessions.size,
    recentCalls: recentCalls.length,
  });
});

app.use((req, res) => {
  log(`404 ${req.method} ${req.path}`);
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`Vobiz Zendesk calling backend on http://localhost:${PORT}`);
  console.log('  accounts    any Vobiz account — agents sign in with their own Auth ID and Auth Token');
  console.log(`  registrar   ${REGISTRAR}`);
  console.log(`  data dir    ${DATA_DIR}`);
  console.log(`  public base ${PUBLIC_BASE || '(NOT SET — Vobiz cannot reach the answer URL, sign-in will refuse)'}`);
  console.log(`  zendesk     ${ZENDESK_SUBDOMAIN || '(unset — ticket sync disabled)'}`);
});
