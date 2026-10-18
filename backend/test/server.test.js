/**
 * Boots the real backend (fetch replaced by fetch-mock.cjs, so nothing leaves
 * the machine) and exercises it over HTTP. Each security case is one that has
 * actually shipped in this repository before.
 *
 * The backend is started with NO Vobiz account values in its environment: any
 * account must be able to sign in. The two accounts below are fakes defined in
 * fetch-mock.cjs.
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-data-'));
const env = {
  PATH: process.env.PATH, PORT: String(PORT), FETCH_LOG, DATA_DIR,
  PUBLIC_BASE: 'https://backend.example.test', SIGNING_SECRET: 'test-signing-secret',
  ZENDESK_SUBDOMAIN: 'acme', ZENDESK_EMAIL: 'admin@acme.test', ZENDESK_API_TOKEN: 'test-zendesk-token',
  TRANSCRIPTION_WEBHOOK_SECRET: 'test-webhook-secret',
};

const ONE = { authId: 'MA_TEST0001', authToken: 'tok-account-one', appId: '43919358318796814' };
const TWO = { authId: 'MA_TEST0002', authToken: 'tok-account-two', appId: '52000000000000017' };
const TOKENS = [ONE.authToken, TWO.authToken];

let server;
let serverOutput = '';
const fetched = () => fs.readFileSync(FETCH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const req = (p, opts = {}) => fetch(`${BASE}${p}`, opts);
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const jsonPost = (body, token) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const bearer = token => ({ headers: { Authorization: `Bearer ${token}` } });

// Every HTTP response body the tests see is collected, so one test can assert
// that no account Auth Token ever left the backend.
const seenBodies = [];
async function text(r) { const t = await r.text(); seenBodies.push(t); return t; }
async function json(r) { return JSON.parse(await text(r)); }

async function login(acct = ONE, agentId = 'zd1001') {
  const r = await req('/login', jsonPost({ agentId, authId: acct.authId, authToken: acct.authToken }));
  const body = await json(r);
  assert.equal(r.status, 200, JSON.stringify(body));
  const agent = await json(await req('/agent', bearer(body.token)));
  return { token: body.token, body, agent, sipUser: agent.sipUser.split('@')[0] };
}

before(async () => {
  fs.writeFileSync(FETCH_LOG, '');
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'fetch-mock.cjs'), path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { serverOutput += String(d); });
  server.stderr.on('data', d => { serverOutput += String(d); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('backend did not start')), 8000);
    server.stdout.on('data', d => { if (String(d).includes('calling backend on')) { clearTimeout(t); resolve(); } });
    server.on('exit', code => reject(new Error(`backend exited ${code}`)));
  });
});
after(() => {
  server && server.kill();
  fs.rmSync(FETCH_LOG, { force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ─── boot ────────────────────────────────────────────────────────────────────
test('boot does not touch any Vobiz account', () => {
  assert.deepEqual(fetched(), []);
});

// ─── sign-in: any account ────────────────────────────────────────────────────
test('login with a wrong token is refused with 401 and creates nothing', async () => {
  const mark = fetched().length;
  const r = await req('/login', jsonPost({ agentId: 'zd9', authId: ONE.authId, authToken: 'wrong' }));
  assert.equal(r.status, 401);
  assert.match((await json(r)).error, /did not accept/);
  const calls = fetched().slice(mark);
  assert.equal(calls.length, 1, 'only the credential check');
  assert.match(calls[0].url, /\/Account\/MA_TEST0001\/numbers\?page=1&per_page=100$/);
});

test('two different accounts both sign in and get distinct endpoints', async () => {
  const a = await login(ONE, 'zd1001');
  const b = await login(TWO, 'zd1002');
  assert.equal(a.body.authId, 'MA_TEST0001');
  assert.equal(b.body.authId, 'MA_TEST0002');
  assert.notEqual(a.sipUser, b.sipUser);
  assert.match(a.sipUser, /^zd1001x[0-9a-f]+1187694299$/, 'the username Vobiz stored, read back');
  assert.deepEqual(a.body.numbers, ['+910000000001', '+910000000002']);
  assert.deepEqual(b.body.numbers, ['+910000000003']);
  assert.notEqual(a.agent.sipPassword, b.agent.sipPassword);

  // Each account's provisioning used only that account's credentials.
  for (const c of fetched().filter(f => f.url.startsWith('https://api.vobiz.ai/'))) {
    const owner = c.url.includes('/MA_TEST0001/') ? ONE : TWO;
    if (c.authToken === 'wrong') continue;
    assert.equal(c.authId, owner.authId, c.url);
    assert.equal(c.authToken, owner.authToken, c.url);
  }

  // The endpoint map on disk holds ids and usernames only — no password, no token.
  const file = path.join(DATA_DIR, 'endpoints.json');
  const stored = fs.readFileSync(file, 'utf8');
  const map = JSON.parse(stored);
  assert.deepEqual(Object.keys(map).sort(), ['MA_TEST0001:zd1001', 'MA_TEST0002:zd1002']);
  assert.equal(map['MA_TEST0001:zd1001'].username, a.sipUser);
  for (const secret of [...TOKENS, a.agent.sipPassword, b.agent.sipPassword]) assert.ok(!stored.includes(secret));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('caller-ID list: every page of List Account Phone Numbers, active and voice-enabled only', async () => {
  const mark = fetched().length;
  const a = await login(ONE, 'zd1004');
  const pages = fetched().slice(mark).filter(c => /\/numbers\?/.test(c.url)).map(c => new URL(c.url).searchParams.get('page'));
  assert.deepEqual(pages, ['1', '2'], 'paged until total was loaded');
  assert.deepEqual(a.body.numbers, ['+910000000001', '+910000000002']);
  assert.ok(!a.body.numbers.includes('+910000000005'), 'released number not offered');
  assert.ok(!a.body.numbers.includes('+910000000006'), 'voice-disabled number not offered');
  assert.equal(a.body.selected, '+910000000001', 'defaults to the first');
  assert.deepEqual(a.body.numberApps, { '+910000000001': '20577609616603585' }, 'shows which app each number is on');
  for (const bad of ['+910000000005', '+910000000006', '+910000000099']) {
    assert.equal((await req('/select-number', jsonPost({ number: bad }, a.token))).status, 400, bad);
  }
  // The last pick is remembered for that agent's next sign-in.
  assert.equal((await req('/select-number', jsonPost({ number: '+910000000002' }, a.token))).status, 200);
  const again = await login(ONE, 'zd1004');
  assert.equal(again.body.selected, '+910000000002');
  assert.equal((await json(await req('/session', bearer(again.token)))).from, '+910000000002');
});

// ─── one endpoint per Zendesk agent ──────────────────────────────────────────
test('agentId must be zd<Zendesk user id>; anything else is refused before Vobiz is touched', async () => {
  const mark = fetched().length;
  for (const agentId of [undefined, '', 'priya', 'zd', 'zd0', 'zd12a', 'ZD12', 'zd1/../2', 'zd1 ', 'zd123456789012345678901', 12]) {
    const r = await req('/login', jsonPost({ agentId, authId: ONE.authId, authToken: ONE.authToken }));
    assert.equal(r.status, 400, String(agentId));
  }
  assert.equal(fetched().length, mark, 'no Vobiz call for a malformed agentId');
});

test('two Zendesk agents on one account get separate endpoints, and one signing in leaves the other\'s password alone', async () => {
  const a = await login(ONE, 'zd2001');
  const mark = fetched().length;
  const b = await login(ONE, 'zd2002');
  assert.notEqual(a.sipUser, b.sipUser);
  assert.match(a.sipUser, /^zd2001x/);
  assert.match(b.sipUser, /^zd2002x/);
  const aEndpoint = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'endpoints.json'), 'utf8'))['MA_TEST0001:zd2001'].endpointId;
  const touchedA = fetched().slice(mark).filter(c => c.method === 'POST' && c.url.endsWith(`/Endpoint/${aEndpoint}/`));
  assert.deepEqual(touchedA, [], 'B\'s sign-in must not rotate A\'s SIP password');
  // A is still signed in, with the password it was given.
  const again = await json(await req('/agent', bearer(a.token)));
  assert.equal(again.sipPassword, a.agent.sipPassword);
  assert.equal(again.sipUser.split('@')[0], a.sipUser);
});

test('a session token is bound to its agent: it cannot read or change another agent', async () => {
  const a = await login(ONE, 'zd2003');
  const b = await login(ONE, 'zd2004');
  // Naming another agent in the body changes nothing: identity comes from the token.
  await req('/select-number', jsonPost({ number: '+910000000002', agentId: 'zd2004' }, a.token));
  assert.equal((await json(await req('/session', bearer(b.token)))).from, '+910000000001');
  assert.equal((await json(await req('/session', bearer(a.token)))).agentId, 'zd2003');
  assert.equal((await json(await req('/agent', bearer(a.token)))).sipUser.split('@')[0], a.sipUser);
  // /login with A's token in the header and B's id still yields a separate B session, not A's.
  const r = await json(await req('/login', jsonPost({ agentId: 'zd2004', authId: ONE.authId, authToken: ONE.authToken }, a.token)));
  assert.notEqual(r.token, a.token);
  assert.equal((await json(await req('/session', bearer(a.token)))).agentId, 'zd2003');
});

test('signing in again as the same agent ends the older session (its SIP password is dead)', async () => {
  const first = await login(ONE, 'zd2005');
  const second = await login(ONE, 'zd2005');
  assert.deepEqual(await json(await req('/session', bearer(first.token))), { loggedIn: false });
  assert.equal((await req('/agent', bearer(first.token))).status, 401);
  assert.equal((await req('/numbers', bearer(first.token))).status, 401);
  assert.equal((await json(await req('/session', bearer(second.token)))).loggedIn, true);
});

test('signing in again reuses the endpoint and rotates its SIP password', async () => {
  const first = await login(ONE, 'zd1003');
  const mark = fetched().length;
  const second = await login(ONE, 'zd1003');
  assert.equal(second.sipUser, first.sipUser);
  assert.notEqual(second.agent.sipPassword, first.agent.sipPassword);
  const calls = fetched().slice(mark);
  assert.ok(!calls.some(c => c.url.endsWith('/Endpoint/') && c.method === 'POST'), 'no second endpoint');
  assert.ok(calls.some(c => /\/Endpoint\/\d+\/$/.test(c.url) && c.method === 'POST' && JSON.parse(c.body).password === second.agent.sipPassword));
});

test('bind sends the 17-digit app id as a string first, and that is all when it takes', async () => {
  const binds = fetched().filter(c => /\/Account\/MA_TEST0001\/Endpoint\/\d+\/$/.test(c.url) && c.method === 'POST' && /app_id|application/.test(c.body));
  assert.ok(binds.length);
  for (const c of binds) assert.equal(c.body, '{"app_id":"43919358318796814"}');
  // Only one application was ever created per account, and never repointed.
  const created = fetched().filter(c => c.url.endsWith('/Application/') && c.method === 'POST');
  assert.equal(created.filter(c => c.url.includes('MA_TEST0001')).length, 1);
  assert.equal(created.filter(c => c.url.includes('MA_TEST0002')).length, 1);
  assert.match(JSON.parse(created[0].body).app_name, /^[A-Za-z0-9_-]+$/);
  assert.equal(JSON.parse(created[0].body).answer_url, 'https://backend.example.test/answer');
  assert.ok(!fetched().some(c => /\/Application\/\d+\/$/.test(c.url) && c.method === 'POST'), 'never updates an application');
});

test('when app_id does not take, the bind is verified and retried with the exact 17-digit integer literal', async () => {
  const two = fetched().filter(c => /\/Account\/MA_TEST0002\/Endpoint\/\d+\/$/.test(c.url) && c.method === 'POST' && /app_id|application/.test(c.body));
  assert.ok(two.some(c => c.body === '{"app_id":"52000000000000017"}'));
  assert.ok(two.some(c => c.body === '{"application":52000000000000017}'), 'raw integer literal, not 52000000000000016 or 5.2e16');
  assert.match(serverOutput, /MA_TEST0002: endpoint \d+ bound to application 52000000000000017 after the documented "application" retry/);
});

test('a lost endpoint map does not create a second endpoint: found again by alias', async () => {
  const first = await login(TWO, 'zd1005');
  fs.rmSync(path.join(DATA_DIR, 'endpoints.json'));
  const mark = fetched().length;
  const again = await login(TWO, 'zd1005');
  assert.equal(again.sipUser, first.sipUser);
  assert.ok(!fetched().slice(mark).some(c => c.url.endsWith('/Endpoint/') && c.method === 'POST'));
});

test('sign-in never moves a number between applications', () => {
  assert.ok(!fetched().some(c => /\/numbers\/.+\/application$/.test(c.url)));
});

// ─── SIP credentials ─────────────────────────────────────────────────────────
test('GET /agent/:anything does not exist', async () => {
  const r = await req('/agent/anyone');
  assert.equal(r.status, 404);
});

test('GET /agent without a session is refused', async () => {
  assert.equal((await req('/agent')).status, 401);
});

test('/session/:agentId does not hand out session details by agent id', async () => {
  await login();
  assert.equal((await req('/session/zd1001')).status, 404);
  assert.deepEqual(await json(await req('/session')), { loggedIn: false });
});

test('SIP direct: works with no account credentials and maps the SIP user to the typed caller ID', async () => {
  const mark = fetched().length;
  const r = await req('/login-sip', jsonPost({ sipUser: 'deskphone01', callerId: '+910000000060' }));
  assert.equal(r.status, 200);
  assert.equal(fetched().length, mark, 'SIP direct makes no Vobiz API call');
  const xml = await text(await req('/answer', form({ From: 'sip:deskphone01@registrar.vobiz.ai', To: '910000000099', CallUUID: 'u-direct' })));
  assert.match(xml, /<Dial callerId="\+910000000060"/);
  // And its number rings it inbound, when no signed-in account claims the DID.
  const inbound = await text(await req('/answer', form({ From: '910000000097', To: '910000000060', CallUUID: 'u-direct-in', Direction: 'inbound' })));
  assert.match(inbound, /<User>sip:deskphone01@registrar\.vobiz\.ai<\/User>/);
  assert.match(inbound, /<Dial callerId="\+910000000060"/);
});

test('SIP direct: X-VH-Caller-ID header on the INVITE sets the caller ID even without /login-sip', async () => {
  const xml = await text(await req('/answer', form({ From: 'sip:deskphone02@registrar.vobiz.ai', To: '910000000099', CallUUID: 'u-hdr', 'SIPHeader_X-VH-Caller-ID': '+910000000061' })));
  assert.match(xml, /<Dial callerId="\+910000000061"/);
});

test('SIP direct cannot claim an endpoint signed in with an account', async () => {
  const a = await login(ONE, 'zd1006');
  const r = await req('/login-sip', jsonPost({ sipUser: a.sipUser, callerId: '+910000000062' }));
  assert.equal(r.status, 409);
});

test('account mode: the X-VH-Caller-ID header is honoured only for that account\'s own numbers', async () => {
  const a = await login(ONE, 'zd1008');
  const own = await text(await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '910000000099', CallUUID: 'u-h1', 'X-VH-Caller-ID': '+910000000002' })));
  assert.match(own, /<Dial callerId="\+910000000002"/);
  const foreign = await text(await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '910000000099', CallUUID: 'u-h2', 'X-VH-Caller-ID': '+910000000003' })));
  assert.match(foreign, /<Dial callerId="\+910000000001"/);
});

// ─── webhooks route to the right account ─────────────────────────────────────
test('outbound answer: identified by SIP user, dials with that account\'s chosen caller ID', async () => {
  const a = await login(ONE, 'zd1015');
  const b = await login(TWO, 'zd1016');
  assert.equal((await req('/select-number', jsonPost({ number: '+910000000002' }, a.token))).status, 200);
  assert.equal((await req('/select-number', jsonPost({ number: '+910000000001' }, b.token))).status, 400, 'not account two\'s number');

  const xa = await text(await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '910000000099', CallUUID: 'u-out-a' })));
  assert.match(xa, /<Record [^>]*recordSession="true"[^>]*\/>\s*<Dial /);
  assert.match(xa, /<Dial callerId="\+910000000002"[^>]*action="https:\/\/backend\.example\.test\/dial-status"[^>]*redirect="false">/);
  assert.match(xa, /<Number>910000000099<\/Number>/);

  const xb = await text(await req('/answer', form({ From: `sip:${b.sipUser}@registrar.vobiz.ai`, To: '910000000098', CallUUID: 'u-out-b' })));
  assert.match(xb, /<Dial callerId="\+910000000003"/);
});

test('outbound from an unknown SIP user is hung up, not dialled', async () => {
  const xml = await text(await req('/answer', form({ From: 'sip:nobody@registrar.vobiz.ai', To: '910000000099', CallUUID: 'u-unk' })));
  assert.match(xml, /<Hangup reason="rejected"\/>/);
  assert.ok(!xml.includes('<Dial'));
});

test('inbound answer: rings the signed-in agents of the account that owns the DID', async () => {
  const a1 = await login(ONE, 'zd1010');
  const a2 = await login(ONE, 'zd1011');
  const b = await login(TWO, 'zd1012');

  const x1 = await text(await req('/answer', form({ From: '910000000097', To: '910000000001', CallUUID: 'u-in-1' })));
  assert.match(x1, /<Dial callerId="\+910000000001" callerName="910000000097"/);
  assert.ok(x1.includes(`<User>sip:${a1.sipUser}@registrar.vobiz.ai</User>`));
  assert.ok(x1.includes(`<User>sip:${a2.sipUser}@registrar.vobiz.ai</User>`));
  assert.ok(!x1.includes(b.sipUser), 'never rings another account\'s agent');

  const x2 = await text(await req('/answer', form({ From: '910000000097', To: '+910000000003', CallUUID: 'u-in-2' })));
  assert.match(x2, /<Dial callerId="\+910000000003"/);
  assert.ok(x2.includes(`<User>sip:${b.sipUser}@registrar.vobiz.ai</User>`));
  assert.ok(!x2.includes(a1.sipUser));
});

test('inbound: ParentAuthID picks the account, ahead of the dialled-number map', async () => {
  const b = await login(TWO, 'zd1017');
  // To is a number account TWO never listed, so only ParentAuthID can route it.
  const xml = await text(await req('/answer', form({ From: '910000000097', To: '00000000099', CallUUID: 'u-pa', Direction: 'inbound', ParentAuthID: 'MA_TEST0002' })));
  assert.ok(xml.includes(`<User>sip:${b.sipUser}@registrar.vobiz.ai</User>`));
  assert.match(xml, /<Dial callerId="\+910000000099"/, '0XXXXXXXXXX (11 digits) becomes +91XXXXXXXXXX');
});

test('inbound to a number no signed-in account owns gets a polite hangup', async () => {
  const xml = await text(await req('/answer', form({ From: '910000000097', To: '910000000050', CallUUID: 'u-in-x' })));
  assert.match(xml, /<Speak>[^<]+<\/Speak>\s*<Hangup\/>/);
  assert.ok(!xml.includes('<Dial'));
  assert.match(serverOutput, /inbound to 910000000050: no signed-in account or SIP-direct agent has this number/);
});

test('Event=Hangup gets an empty Response', async () => {
  const xml = await text(await req('/answer', form({ Event: 'Hangup', CallUUID: 'u-in' })));
  assert.match(xml, /<Response><\/Response>/);
});

test('a caller ID cannot inject XML into the answer document', async () => {
  const a = await login(ONE, 'zd1013');
  const evil = '+1"/><Number>19005550100</Number></Dial><Dial callerId="+1';
  assert.equal((await req('/select-number', jsonPost({ number: evil }, a.token))).status, 400);
  assert.equal((await req('/login-sip', jsonPost({ sipUser: 'deskphone03', callerId: evil }))).status, 400);
  const direct = await text(await req('/answer', form({ From: 'sip:deskphone03@registrar.vobiz.ai', To: '910000000099', CallUUID: 'u-x2', 'X-VH-Caller-ID': evil })));
  assert.ok(!direct.includes('19005550100'));
  const xml = await text(await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '910000000099', CallUUID: 'u-x', 'X-VH-Caller-ID': evil })));
  assert.ok(!xml.includes('19005550100'));
  assert.equal((xml.match(/<Dial /g) || []).length, 1);
});

test('a destination that is not a phone number is rejected, not dialled', async () => {
  const a = await login(ONE, 'zd1007');
  const xml = await text(await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '</Number><Number>1900', CallUUID: 'u-y' })));
  assert.match(xml, /<Hangup reason="rejected"\/>/);
});

// ─── recordings ──────────────────────────────────────────────────────────────
test('recordings list and call records need a session', async () => {
  assert.equal((await req('/recordings')).status, 401);
  assert.equal((await req('/recordings/anyone')).status, 404);
  assert.equal((await req('/call-record')).status, 401);
});

test('/play-recording without a valid signature streams nothing', async () => {
  for (const q of ['', '?callUuid=call-1', '?authId=MA_TEST0001&callUuid=call-1&exp=9999999999&sig=00']) {
    const r = await req(`/play-recording${q}`);
    assert.equal(r.status, 403, q);
  }
});

test('/recording-audio without a valid signature streams nothing', async () => {
  assert.equal((await req('/recording-audio/rec-1')).status, 403);
  assert.equal((await req('/recording-audio/rec-1?authId=MA_TEST0001&exp=9999999999&sig=00')).status, 403);
});

test('no proxy route takes a caller-supplied URL', async () => {
  assert.equal((await req('/recording-file?url=https://example.com/')).status, 404);
});

test('recordings list shows only calls this backend handled for the account, not the whole account', async () => {
  const a = await login(ONE, 'zd2006');
  // Nothing handled yet for this account: the foreign recording is not shown.
  assert.deepEqual((await json(await req('/recordings', bearer(a.token)))).objects, []);
  await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '910000000091', CallUUID: 'call-1' }));
  const list = await json(await req('/recordings', bearer(a.token)));
  assert.deepEqual(list.objects.map(o => o.recording_id), ['rec-1']);
  // The other account's ledger does not leak into this one.
  const b = await login(TWO, 'zd2007');
  assert.deepEqual((await json(await req('/recordings', bearer(b.token)))).objects, []);
});

test('signed panel links are account-scoped: each plays its own audio, swapping the account breaks it', async () => {
  const a = await login(ONE, 'zd1018');
  const b = await login(TWO, 'zd1019');
  await req('/answer', form({ From: `sip:${b.sipUser}@registrar.vobiz.ai`, To: '910000000092', CallUUID: 'call-2' }));
  const la = await json(await req('/recordings', bearer(a.token)));
  const lb = await json(await req('/recordings', bearer(b.token)));
  const ua = new URL(la.objects[0].playUrl);
  const ub = new URL(lb.objects[0].playUrl);
  assert.equal(ua.searchParams.get('authId'), 'MA_TEST0001');
  assert.equal(ub.searchParams.get('authId'), 'MA_TEST0002');

  assert.equal(await text(await req(ua.pathname + ua.search)), 'AUDIO:rec-1.mp3');
  assert.equal(await text(await req(ub.pathname + ub.search)), 'AUDIO:rec-2.mp3');

  // Same signature, other account: refused.
  const swapped = new URL(ua); swapped.searchParams.set('authId', 'MA_TEST0002');
  assert.equal((await req(swapped.pathname + swapped.search)).status, 403);
  // Tampered signature: refused.
  const tampered = ua.search.replace(/sig=([0-9a-f])/, (m, c) => `sig=${c === 'a' ? 'b' : 'a'}`);
  assert.equal((await req(ua.pathname + tampered)).status, 403);
  // Audio was fetched with the owning account's credentials.
  const media = fetched().filter(f => f.url.startsWith('https://media.vobiz.test/'));
  assert.ok(media.some(f => f.url.endsWith('rec-1.mp3') && f.authToken === ONE.authToken));
  assert.ok(media.some(f => f.url.endsWith('rec-2.mp3') && f.authToken === TWO.authToken));
});

test('ticket link is signed over the account, credential-free, and plays only that call', async () => {
  const a = await login(ONE, 'zd1021');
  await req('/answer', form({ From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: '910000000091', CallUUID: 'call-1' }));
  const rec = await json(await req('/call-record?to=910000000091', bearer(a.token)));
  assert.equal(rec.callUuid, 'call-1');
  const u = new URL(rec.recordingUrl);
  assert.equal(u.origin, 'https://backend.example.test');
  assert.equal(u.searchParams.get('authId'), 'MA_TEST0001');
  assert.match(u.search, /exp=\d+&sig=[0-9a-f]{64}/);
  const r = await req(u.pathname + u.search);
  assert.equal(r.status, 200);
  assert.equal(await text(r), 'AUDIO:rec-1.mp3', 'must pick the recording whose call_uuid matches, not items[0]');

  const swapped = new URL(u); swapped.searchParams.set('authId', 'MA_TEST0002');
  assert.equal((await req(swapped.pathname + swapped.search)).status, 403);
});

test('another account cannot see this account\'s call records', async () => {
  const b = await login(TWO, 'zd1020');
  const rec = await json(await req('/call-record?to=910000000091', bearer(b.token)));
  assert.equal(rec.found, false);
});

// ─── Zendesk credentials ─────────────────────────────────────────────────────
test('the Zendesk API token cannot be aimed at another host', async () => {
  const before = fetched().length;
  const { token } = await login();
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

// ─── inbound setup ───────────────────────────────────────────────────────────
test('/setup-inbound attaches the selected number to the account\'s app via the documented route', async () => {
  const a = await login(ONE, 'zd1009');
  await req('/select-number', jsonPost({ number: '+910000000002' }, a.token));
  const mark = fetched().length;
  const r = await req('/setup-inbound', jsonPost({}, a.token));
  assert.equal(r.status, 200);
  const calls = fetched().slice(mark);
  const attach = calls.find(c => c.url.endsWith('/Account/MA_TEST0001/numbers/%2B910000000002/application'));
  assert.ok(attach, 'number attach must use POST /numbers/{e164}/application');
  assert.equal(attach.body, '{"application_id":"43919358318796814"}');
  assert.equal(attach.authToken, ONE.authToken);

  await req('/select-number', jsonPost({ number: '+910000000001' }, a.token));
  const moved = await json(await req('/setup-inbound', jsonPost({}, a.token)));
  assert.equal(moved.previousAppId, '20577609616603585');
  assert.match(moved.message, /moved off application 20577609616603585/);
});

test('/setup-inbound needs a session', async () => {
  assert.equal((await req('/setup-inbound', jsonPost({}))).status, 401);
});

test('static files are not served — no path traversal to .env', async () => {
  for (const p of ['/../backend/.env', '/..%2fbackend%2f.env', '/.env', '/backend/.env', '/data/endpoints.json']) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 404, p);
  }
});

// ─── the account Auth Token never leaves the backend ─────────────────────────
test('no HTTP response and no log line ever contains an account Auth Token', async () => {
  // A few more surfaces, so the check covers every route that returns data.
  const a = await login(ONE, 'zd1014');
  for (const p of ['/session', '/numbers', '/agent', '/recordings', '/call-record', '/health']) {
    await text(await req(p, bearer(a.token)));
  }
  assert.ok(seenBodies.length > 30);
  for (const body of seenBodies) {
    for (const t of TOKENS) assert.ok(!body.includes(t), `token leaked in a response: ${body.slice(0, 120)}`);
  }
  for (const t of TOKENS) assert.ok(!serverOutput.includes(t), 'token leaked in the server log');
});
