/**
 * Boots the real backend (fetch replaced by fetch-mock.cjs, so nothing leaves
 * the machine) and exercises it over HTTP. Each security case is one that has
 * actually shipped in this repository before.
 *
 * Run: npm test   (from the repo root, or `node --test` in backend/)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const FETCH_LOG = path.join(os.tmpdir(), `zd-fetch-${PORT}.jsonl`);
const env = {
  PATH: process.env.PATH, PORT: String(PORT), FETCH_LOG,
  VOBIZ_AUTH_ID: 'MA_TEST', VOBIZ_AUTH_TOKEN: 'test-auth-token', VOBIZ_FROM_NUMBER: '+910000000001',
  VOBIZ_SIP_USER: 'testagent123', VOBIZ_SIP_PASSWORD: 'test-sip-password',
  PUBLIC_BASE: 'https://backend.example.test', SIGNING_SECRET: 'test-signing-secret',
  ZENDESK_SUBDOMAIN: 'acme', ZENDESK_EMAIL: 'admin@acme.test', ZENDESK_API_TOKEN: 'test-zendesk-token',
  TRANSCRIPTION_WEBHOOK_SECRET: 'test-webhook-secret',
};

let server;
const fetched = () => fs.readFileSync(FETCH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const req = (p, opts = {}) => fetch(`${BASE}${p}`, opts);
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const jsonPost = (body, token) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function login() {
  const r = await req('/login', jsonPost({ agentId: 'priya', authId: 'MA_TEST', authToken: 'test-auth-token' }));
  assert.equal(r.status, 200);
  return (await r.json()).token;
}

before(async () => {
  fs.writeFileSync(FETCH_LOG, '');
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'fetch-mock.cjs'), path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('backend did not start')), 8000);
    server.stdout.on('data', d => { if (String(d).includes('calling backend on')) { clearTimeout(t); resolve(); } });
    server.on('exit', code => reject(new Error(`backend exited ${code}`)));
  });
});
after(() => { server && server.kill(); fs.rmSync(FETCH_LOG, { force: true }); });

// ─── boot ────────────────────────────────────────────────────────────────────
test('boot does not touch the Vobiz account', () => {
  assert.deepEqual(fetched(), []);
});

// ─── SIP credentials ─────────────────────────────────────────────────────────
test('GET /agent/:anything does not exist', async () => {
  const r = await req('/agent/anyone');
  assert.equal(r.status, 404);
  assert.ok(!(await r.text()).includes('test-sip-password'));
});

test('GET /agent without a session is refused and leaks nothing', async () => {
  const r = await req('/agent');
  assert.equal(r.status, 401);
  assert.ok(!(await r.text()).includes('test-sip-password'));
});

test('GET /agent with a session returns the SIP identity', async () => {
  const token = await login();
  const r = await req('/agent', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.sipUser, 'testagent123@registrar.vobiz.ai');
  assert.equal(body.sipPassword, 'test-sip-password');
});

test('login with the wrong token is refused', async () => {
  const r = await req('/login', jsonPost({ agentId: 'x', authId: 'MA_TEST', authToken: 'wrong' }));
  assert.equal(r.status, 401);
});

test('/session/:agentId does not hand out session details by agent id', async () => {
  await login();
  assert.equal((await req('/session/priya')).status, 404);
  assert.deepEqual(await (await req('/session')).json(), { loggedIn: false });
});

// ─── recordings ──────────────────────────────────────────────────────────────
test('recordings list and call records need a session', async () => {
  assert.equal((await req('/recordings')).status, 401);
  assert.equal((await req('/recordings/anyone')).status, 404);
  assert.equal((await req('/call-record')).status, 401);
});

test('/play-recording without a valid signature streams nothing', async () => {
  for (const q of ['', '?callUuid=call-1', '?callUuid=call-1&exp=9999999999&sig=00']) {
    const r = await req(`/play-recording${q}`);
    assert.equal(r.status, 403, q);
  }
});

test('/recording-audio without a valid signature streams nothing', async () => {
  assert.equal((await req('/recording-audio/rec-1')).status, 403);
  assert.equal((await req('/recording-audio/rec-1?exp=9999999999&sig=00')).status, 403);
});

test('no proxy route takes a caller-supplied URL', async () => {
  assert.equal((await req('/recording-file?url=https://example.com/')).status, 404);
});

test('signed panel link plays the recording; tampering breaks it', async () => {
  const token = await login();
  const list = await (await req('/recordings', { headers: { Authorization: `Bearer ${token}` } })).json();
  const playUrl = new URL(list.objects[0].playUrl);
  assert.ok(!playUrl.search.includes('test-auth-token'));
  const ok = await req(playUrl.pathname + playUrl.search);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'AUDIO:rec-1.mp3');
  const tampered = playUrl.search.replace(/sig=([0-9a-f])/, (m, c) => `sig=${c === 'a' ? 'b' : 'a'}`);
  assert.equal((await req(playUrl.pathname + tampered)).status, 403);
});

test('ticket link is signed, credential-free, and plays only that call', async () => {
  const token = await login();
  await req('/answer', form({ From: 'sip:testagent123@registrar.vobiz.ai', To: '910000000099', CallUUID: 'call-1' }));
  const rec = await (await req('/call-record?to=910000000099', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(rec.callUuid, 'call-1');
  const u = new URL(rec.recordingUrl);
  assert.equal(u.origin, 'https://backend.example.test');
  assert.match(u.search, /exp=\d+&sig=[0-9a-f]{64}/);
  assert.ok(!rec.recordingUrl.includes('test-auth-token'));
  const r = await req(u.pathname + u.search);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'AUDIO:rec-1.mp3', 'must pick the recording whose call_uuid matches, not items[0]');
});

// ─── VobizXML ────────────────────────────────────────────────────────────────
test('outbound answer: browser A leg gets Record then Dial Number', async () => {
  const r = await req('/answer', form({ From: 'sip:testagent123@registrar.vobiz.ai', To: '910000000099', CallUUID: 'u-out' }));
  const xml = await r.text();
  assert.match(xml, /<Record [^>]*recordSession="true"[^>]*\/>\s*<Dial /);
  assert.match(xml, /<Dial callerId="\+910000000001"[^>]*action="https:\/\/backend\.example\.test\/dial-status"[^>]*redirect="false">/);
  assert.match(xml, /<Number>910000000099<\/Number>/);
});

test('inbound answer: Dial User with callerId = dialled DID in E.164', async () => {
  const xml = await (await req('/answer', form({ From: '910000000097', To: '910000000098', CallUUID: 'u-in' }))).text();
  assert.match(xml, /<Dial callerId="\+910000000098" callerName="910000000097"/);
  assert.match(xml, /<User>sip:testagent123@registrar\.vobiz\.ai<\/User>/);
});

test('Event=Hangup gets an empty Response', async () => {
  const xml = await (await req('/answer', form({ Event: 'Hangup', CallUUID: 'u-in' }))).text();
  assert.match(xml, /<Response><\/Response>/);
});

test('a caller ID cannot inject XML into the answer document', async () => {
  const evil = '+1"/><Number>19005550100</Number></Dial><Dial callerId="+1';
  const r = await req('/login-sip', jsonPost({ sipUser: 'testagent123', callerId: evil }));
  assert.equal(r.status, 400);
  const xml = await (await req('/answer', form({ From: 'sip:testagent123@registrar.vobiz.ai', To: '910000000099', CallUUID: 'u-x', 'X-VH-Caller-ID': evil }))).text();
  assert.ok(!xml.includes('19005550100'));
  assert.equal((xml.match(/<Dial /g) || []).length, 1);
});

test('a destination that is not a phone number is rejected, not dialled', async () => {
  const xml = await (await req('/answer', form({ From: 'sip:testagent123@registrar.vobiz.ai', To: '</Number><Number>1900', CallUUID: 'u-y' }))).text();
  assert.match(xml, /<Hangup reason="rejected"\/>/);
});

test('/login-sip only accepts numbers the account owns', async () => {
  assert.equal((await req('/login-sip', jsonPost({ sipUser: 'testagent123', callerId: '+910000000099' }))).status, 400);
  assert.equal((await req('/login-sip', jsonPost({ sipUser: 'testagent123', callerId: '+910000000002' }))).status, 200);
});

// ─── Zendesk credentials ─────────────────────────────────────────────────────
test('the Zendesk API token cannot be aimed at another host', async () => {
  const before = fetched().length;
  const token = await login();
  await req('/sync-call', jsonPost({ subdomain: 'evil.example/x?', email: 'a@b', apiToken: 'x', ticketId: 1 }, token));
  await req('/transcription-ready', {
    ...jsonPost({ subdomain: 'evil.example/x?', ticketId: 1, transcript: 'hi' }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-webhook-secret' },
  });
  const hosts = fetched().slice(before).map(f => new URL(f.url).host);
  assert.ok(hosts.every(h => h === 'acme.zendesk.com' || h === 'api.vobiz.ai'), hosts.join(','));
});

test('/transcription-ready requires its shared secret', async () => {
  const r = await req('/transcription-ready', jsonPost({ ticketId: 1, transcript: 'hi' }));
  assert.equal(r.status, 401);
});

// ─── CORS ────────────────────────────────────────────────────────────────────
test('CORS: ZAF iframe origin allowed, others not echoed, never *', async () => {
  const acao = async origin => (await req('/health', { headers: { Origin: origin } })).headers.get('access-control-allow-origin');
  assert.equal(await acao('https://12345.apps.zdusercontent.com'), 'https://12345.apps.zdusercontent.com');
  assert.equal(await acao('https://acme.zendesk.com'), 'https://acme.zendesk.com');
  assert.equal(await acao('https://evil.example'), null);
  assert.equal(await acao('https://acme.zendesk.com.evil.example'), null);
});

// ─── setup ───────────────────────────────────────────────────────────────────
test('/setup binds the endpoint but does not move the DID; /setup-inbound does, via the documented route', async () => {
  const token = await login();
  let mark = fetched().length;
  assert.equal((await req('/setup', jsonPost({}, token))).status, 200);
  let calls = fetched().slice(mark);
  assert.ok(calls.some(c => c.url.endsWith('/Endpoint/EP1/') && JSON.parse(c.body).app_id === 'APP1'));
  assert.ok(!calls.some(c => /\/numbers\/.+\/application$/.test(c.url)));
  const created = calls.find(c => c.url.endsWith('/Application/') && c.method === 'POST');
  assert.match(JSON.parse(created.body).app_name, /^[A-Za-z0-9_-]+$/);

  mark = fetched().length;
  assert.equal((await req('/setup-inbound', jsonPost({}, token))).status, 200);
  calls = fetched().slice(mark);
  const attach = calls.find(c => c.url.endsWith('/numbers/%2B910000000001/application'));
  assert.ok(attach, 'number attach must use POST /numbers/{e164}/application');
  assert.deepEqual(JSON.parse(attach.body), { application_id: 'APP1' });
});

test('static files are not served — no path traversal to .env', async () => {
  for (const p of ['/../backend/.env', '/..%2fbackend%2f.env', '/.env', '/backend/.env']) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 404, p);
  }
});
