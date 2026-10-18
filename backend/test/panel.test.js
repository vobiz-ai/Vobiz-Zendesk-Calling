/**
 * Runs the real panel script (assets/scripts/app.js) in a vm with a minimal
 * fake DOM, ZAF client, JsSIP and fetch. Covers the panel logic that has no
 * browser dependency worth simulating: which agent id it signs in as, and what
 * it does when the backend no longer knows its session.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const APP_JS = fs.readFileSync(path.join(ROOT, 'assets', 'scripts', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'assets', 'index.html'), 'utf8');

function fakeElement(id) {
  return {
    id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', className: '',
    classList: { toggle() {} },
    setAttribute() {}, addEventListener() {}, appendChild() {},
  };
}

/**
 * Boots app.js. `routes` maps "METHOD /path" to (body) => [status, json].
 */
async function boot({ routes, inZendesk = true, userId = 4242, storedToken = '' }) {
  const elements = new Map();
  const getEl = id => { if (!elements.has(id)) elements.set(id, fakeElement(id)); return elements.get(id); };
  const requests = [];
  const intervals = [];
  const uas = [];
  const session = new Map(storedToken ? [['vobiz_session_token', storedToken]] : []);

  class UA {
    constructor(cfg) { this.cfg = cfg; this.handlers = {}; this.stopped = false; this.unregistered = false; uas.push(this); }
    on(ev, fn) { this.handlers[ev] = fn; }
    start() { if (this.handlers.registered) this.handlers.registered(); }
    stop() { this.stopped = true; }
    unregister() { this.unregistered = true; }
    removeAllListeners() { this.handlers = {}; }
    isRegistered() { return !this.stopped; }
  }

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    window: { location: { search: inZendesk ? '?origin=https://acme.zendesk.com' : '' }, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia() {} } },
    document: { getElementById: getEl, addEventListener() {}, createElement: () => fakeElement('') },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: {
      getItem: k => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: k => session.delete(k),
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: () => 0,
    JsSIP: { UA, WebSocketInterface: class {} },
    fetch: async (url, opts = {}) => {
      const p = new URL(url).pathname;
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      requests.push({ method, path: p, body, auth: (opts.headers || {}).Authorization || null });
      const handler = routes[`${method} ${p}`];
      const [status, json] = handler ? handler(body) : [404, { error: 'no route' }];
      return { status, ok: status >= 200 && status < 300, json: async () => json };
    },
  };
  if (inZendesk) {
    ctx.ZAFClient = {
      init: () => ({
        invoke: async () => {},
        on() {},
        metadata: async () => ({ settings: { backend_url: 'https://backend.example.test' } }),
        context: async () => ({ account: { subdomain: 'acme' } }),
        get: async key => (key === 'currentUser' ? { currentUser: { id: userId, email: 'agent@acme.test' } } : {}),
        request: async () => ({}),
      }),
    };
  }
  vm.createContext(ctx);
  vm.runInContext(APP_JS, ctx);
  const settle = () => new Promise(r => setImmediate(r));
  for (let i = 0; i < 20; i++) await settle();
  return {
    ctx, requests, intervals, uas, session, getEl, settle,
    run: code => vm.runInContext(code, ctx),
    async flush() { for (let i = 0; i < 20; i++) await settle(); },
  };
}

const LOGIN_OK = () => [200, { token: 'tok-1', numbers: ['+910000000001'], numberApps: {}, selected: '+910000000001', appId: '1' }];
const AGENT_OK = () => [200, { sipUser: 'zd4242xabc@registrar.vobiz.ai', sipPassword: 'p', displayName: 'zd4242 (Vobiz)' }];

async function signedIn(extraRoutes = {}) {
  const routes = {
    'GET /session': () => [200, { loggedIn: false }],
    'POST /login': LOGIN_OK,
    'GET /agent': AGENT_OK,
    'GET /recordings': () => [200, { objects: [] }],
    ...extraRoutes,
  };
  const h = await boot({ routes });
  h.getEl('vobiz-auth-id').value = 'MA_TEST0001';
  h.getEl('vobiz-auth-token').value = 'secret';
  await h.run('vobizLogin()');
  await h.flush();
  return { h, routes };
}

test('panel signs in as zd<Zendesk user id> from ZAF currentUser, not an app setting', async () => {
  const { h } = await signedIn();
  const login = h.requests.find(r => r.path === '/login');
  assert.equal(login.body.agentId, 'zd4242');
  assert.equal(h.getEl('status').textContent, 'READY');
  assert.ok(!/settings\.agent_id/.test(APP_JS), 'agent_id setting is no longer read');
});

test('panel refuses to start without a readable Zendesk user', async () => {
  const h = await boot({ routes: {}, userId: null });
  assert.match(h.getEl('status-message').textContent, /Zendesk user/);
  assert.equal(h.requests.length, 0);
});

test('a 401 on any session call drops the panel to SIGNED OUT and unregisters SIP', async () => {
  const { h, routes } = await signedIn();
  assert.equal(h.uas.length, 1);
  routes['GET /numbers'] = () => [401, { error: 'Not logged in' }];
  await h.run('backendJson("/numbers").catch(() => {})');
  await h.flush();
  assert.equal(h.getEl('status').textContent, 'SIGNED OUT');
  assert.match(h.getEl('status-message').textContent, /Please sign in again/);
  assert.match(h.getEl('vobiz-login-status').textContent, /Please sign in again/);
  assert.ok(h.uas[0].stopped && h.uas[0].unregistered, 'SIP UA unregistered and stopped');
  assert.equal(h.session.has('vobiz_session_token'), false);
  assert.equal(h.getEl('dialbtn').disabled, true);
  assert.equal(h.run('sessionToken'), '');
});

test('the periodic session check signs out when the backend forgot the session', async () => {
  const { h } = await signedIn();
  const check = h.intervals.find(i => i.ms === 60000);
  assert.ok(check, 'a 60 s session check is scheduled after sign-in');
  assert.equal(h.getEl('status').textContent, 'READY');
  await check.fn(); // /session still answers { loggedIn: false }: backend restarted
  await h.flush();
  assert.equal(h.getEl('status').textContent, 'SIGNED OUT');
  assert.ok(h.uas[0].stopped);
  const sessionCheck = h.requests.filter(r => r.path === '/session').pop();
  assert.equal(sessionCheck.auth, 'Bearer tok-1');
});

test('a session still alive keeps the panel READY', async () => {
  const { h, routes } = await signedIn();
  routes['GET /session'] = () => [200, { loggedIn: true, numbers: [], authId: 'MA_TEST0001' }];
  await h.intervals.find(i => i.ms === 60000).fn();
  await h.flush();
  assert.equal(h.getEl('status').textContent, 'READY');
  assert.equal(h.uas[0].stopped, false);
});

test('a session lost mid-call waits for the call to end before signing out', async () => {
  const { h, routes } = await signedIn();
  h.run('currentRTCSession = { terminate() {} }');
  routes['GET /numbers'] = () => [401, {}];
  await h.run('backendJson("/numbers").catch(() => {})');
  await h.flush();
  assert.equal(h.uas[0].stopped, false, 'the live call is not cut');
  h.run('currentRTCSession = null; afterCallEnded()');
  assert.equal(h.getEl('status').textContent, 'SIGNED OUT');
  assert.ok(h.uas[0].stopped);
});

test('a wrong Auth Token at /login is a login failure, not a session expiry', async () => {
  const h = await boot({ routes: { 'GET /session': () => [200, { loggedIn: false }], 'POST /login': () => [401, { error: 'Vobiz did not accept that Auth ID and Auth Token.' }] } });
  h.getEl('vobiz-auth-id').value = 'MA_TEST0001';
  h.getEl('vobiz-auth-token').value = 'wrong';
  await h.run('vobizLogin()');
  await h.flush();
  assert.match(h.getEl('vobiz-login-status').textContent, /^Login failed: Vobiz did not accept/);
});

test('reopening the panel with a token the backend forgot asks to sign in again', async () => {
  const h = await boot({ routes: { 'GET /session': () => [200, { loggedIn: false }] }, storedToken: 'old' });
  assert.equal(h.getEl('status').textContent, 'SIGNED OUT');
  assert.match(h.getEl('status-message').textContent, /Please sign in again/);
  assert.equal(h.session.has('vobiz_session_token'), false);
});

test('panel text: the browser places the call; phone-number click-to-dial is Talk Partner Edition only', () => {
  assert.ok(!/dials the customer first/i.test(INDEX_HTML));
  assert.ok(!/bridges your browser in/i.test(INDEX_HTML));
  assert.match(INDEX_HTML, /Your browser places the call/);
  assert.match(INDEX_HTML, /Call requester/);
  assert.match(INDEX_HTML, /Talk Partner Edition/);
  assert.ok(!/click any phone number in\s+Zendesk and this panel dials it/i.test(INDEX_HTML));
});

test('manifest no longer declares agent_id', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.parameters.map(p => p.name).sort(), ['backend_url', 'registrar_url']);
});
