// Preloaded into the backend under test (node -r). Replaces global fetch so no
// request leaves the machine, and records every attempted request to a JSONL
// file so tests can assert on what the server *tried* to send, and where.
//
// Simulates two Vobiz accounts with obvious fake values. Behaviours copied from
// the real API on purpose:
//  - POST /Endpoint/ rewrites the submitted username;
//  - app ids are 17 digits and come back UNQUOTED in endpoint reads, so a
//    server that runs them through JSON.parse/Number gets the wrong id;
//  - MA_TEST0001 binds on `{"app_id":"<string>"}` (what the reference
//    playground sends); MA_TEST0002 ignores that and only honours the
//    documented `{"application": <integer>}`, which exercises the
//    bind-verify-retry path.
const fs = require('node:fs');
const LOG = process.env.FETCH_LOG;

const ACCOUNTS = {
  MA_TEST0001: { token: 'tok-account-one', numbers: ['+910000000001', '+910000000002'], inactive: '+910000000005', noVoice: '+910000000006', appId: '43919358318796814', honoursAppId: true },
  MA_TEST0002: { token: 'tok-account-two', numbers: ['+910000000003'], inactive: '+910000000007', noVoice: '+910000000008', appId: '52000000000000017', honoursAppId: false },
};
const apps = { MA_TEST0001: [], MA_TEST0002: [] };
const endpoints = {};   // endpointId -> { authId, username, password, app }
let nextEndpoint = 700001;

const recordingsFor = authId => authId === 'MA_TEST0001'
  ? [
    // A call some other system on the same account made: never shown in this panel.
    { recording_id: 'rec-foreign', call_uuid: 'not-handled-here', recording_url: 'https://media.vobiz.test/rec-foreign.mp3', add_time: 't', rounded_recording_duration: 30 },
    { recording_id: 'rec-1', call_uuid: 'call-1', recording_url: 'https://media.vobiz.test/rec-1.mp3', add_time: 't', rounded_recording_duration: 9 },
  ]
  : [{ recording_id: 'rec-2', call_uuid: 'call-2', recording_url: 'https://media.vobiz.test/rec-2.mp3', add_time: 't', rounded_recording_duration: 7 }];

global.fetch = async (url, opts = {}) => {
  url = String(url);
  const h = opts.headers || {};
  const method = opts.method || 'GET';
  fs.appendFileSync(LOG, JSON.stringify({
    url, method,
    authorization: h.Authorization || null, authId: h['X-Auth-ID'] || null, authToken: h['X-Auth-Token'] || null,
    body: opts.body || null,
  }) + '\n');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const raw = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/json' } });

  if (url.startsWith('https://media.vobiz.test/')) {
    const acct = Object.entries(ACCOUNTS).find(([id, a]) => id === h['X-Auth-ID'] && a.token === h['X-Auth-Token']);
    if (!acct) return json({ error: 'unauthorized' }, 401);
    return new Response(`AUDIO:${url.split('/').pop()}`, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (url.startsWith('https://acme.zendesk.com/')) return json({ ticket: { id: 42 } });
  if (!url.startsWith('https://api.vobiz.ai/')) return json({ unexpected: url }, 599);

  const m = url.match(/^https:\/\/api\.vobiz\.ai\/api\/v1\/Account\/([^/]+)(\/.*)$/);
  if (!m) return json({}, 404);
  const authId = decodeURIComponent(m[1]);
  const p = m[2];
  const acct = ACCOUNTS[authId];
  if (!acct || h['X-Auth-ID'] !== authId || h['X-Auth-Token'] !== acct.token) {
    return json({ error: 'authentication failed' }, 401);
  }

  if (p.startsWith('/numbers?')) {
    // List Account Phone Numbers: { items, page, per_page, total }. Served two
    // per page whatever per_page says, so the server must really paginate. Each
    // account also has one inactive and one voice-disabled number, which must
    // never be offered as a caller ID.
    const all = [
      ...acct.numbers.map((e164, i) => ({ e164, status: 'active', voice_enabled: true, application_id: i === 0 ? '20577609616603585' : '' })),
      { e164: acct.inactive, status: 'released', voice_enabled: true },
      { e164: acct.noVoice, status: 'active', voice_enabled: false },
    ];
    const page = Number(new URLSearchParams(p.split('?')[1]).get('page') || 1);
    return json({ items: all.slice((page - 1) * 2, page * 2), page, per_page: 2, total: all.length });
  }
  if (/^\/numbers\/[^/]+\/application$/.test(p) && method === 'POST') return json({ message: 'Number attached to application' });

  if (p.startsWith('/Application/') && method === 'GET') {
    // Unquoted 17-digit ids, like a careless serializer would send.
    const body = '{"objects":[' + apps[authId].map(a => `{"app_id":${a.app_id},"app_name":"${a.app_name}","answer_url":"${a.answer_url}"}`).join(',') + ']}';
    return raw(body);
  }
  if (p === '/Application/' && method === 'POST') {
    const b = JSON.parse(opts.body);
    apps[authId].push({ app_id: acct.appId, app_name: b.app_name, answer_url: b.answer_url });
    return raw(`{"api_id":"x","app_id":${acct.appId},"message":"created"}`, 201);
  }

  if (p.startsWith('/Endpoint/?') && method === 'GET') {
    const mine = Object.entries(endpoints).filter(([, e]) => e.authId === authId);
    return json({ objects: mine.map(([id, e]) => ({ endpoint_id: id, username: e.username, alias: e.alias })) });
  }
  if (p === '/Endpoint/' && method === 'POST') {
    const b = JSON.parse(opts.body);
    if (!/^[A-Za-z0-9]+$/.test(b.username)) return json({ error: 'invalid request parameters' }, 400);
    const id = String(nextEndpoint++);
    endpoints[id] = { authId, username: `${b.username}1187694299`, alias: b.alias, password: b.password, app: null };
    return json({ message: 'created', endpoint_id: id, sip_uri: `sip:${b.username}@registrar.vobiz.ai` }, 201);
  }
  const ep = p.match(/^\/Endpoint\/(\d+)\/$/);
  if (ep) {
    const e = endpoints[ep[1]];
    if (!e || e.authId !== authId) return new Response('', { status: 404 });
    if (method === 'GET') {
      const appPart = e.app ? `{"app_id":${e.app},"app_name":"Zendesk-Calling-Vobiz"}` : 'null';
      return raw(`{"endpoint_id":"${ep[1]}","username":"${e.username}","application":${appPart}}`);
    }
    const text = String(opts.body);
    const b = JSON.parse(text);
    if (b.password) e.password = b.password;
    // Take the id from the raw text, the way the real server sees it.
    const appLit = text.match(/"application"\s*:\s*(\d+)/);
    const appIdLit = text.match(/"app_id"\s*:\s*"(\d+)"/);
    if (appLit) e.app = appLit[1];
    if (appIdLit && acct.honoursAppId) e.app = appIdLit[1];
    return new Response('', { status: 202 });
  }

  if (p.startsWith('/Recording/?call_uuid=')) {
    // Simulates the filter being ignored upstream: returns someone else's call first.
    return json({ objects: [
      { recording_id: 'other', call_uuid: 'someone-else', recording_url: 'https://media.vobiz.test/other.mp3' },
      ...recordingsFor(authId),
    ] });
  }
  const rec = p.match(/^\/Recording\/([^/?]+)\/$/);
  if (rec) {
    const found = recordingsFor(authId).find(r => r.recording_id === rec[1]);
    return found ? json(found) : json({ error: 'not found' }, 404);
  }
  if (p.startsWith('/Recording/')) return json({ objects: recordingsFor(authId) });
  return json({}, 404);
};
