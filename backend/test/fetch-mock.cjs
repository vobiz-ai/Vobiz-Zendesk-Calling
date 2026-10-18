// Preloaded into the backend under test (node -r). Replaces global fetch so no
// request leaves the machine, and records every attempted request to a JSONL
// file so tests can assert on what the server *tried* to send, and where.
const fs = require('node:fs');
const LOG = process.env.FETCH_LOG;

global.fetch = async (url, opts = {}) => {
  url = String(url);
  const h = opts.headers || {};
  fs.appendFileSync(LOG, JSON.stringify({
    url, method: opts.method || 'GET',
    authorization: h.Authorization || null, authToken: h['X-Auth-Token'] || null,
    body: opts.body || null,
  }) + '\n');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  if (url.startsWith('https://api.vobiz.ai/')) {
    if (url.includes('/numbers?')) return json({ objects: [{ e164: '+910000000001' }, { e164: '+910000000002' }] });
    if (url.includes('/numbers/') && url.endsWith('/application')) return json({ message: 'Number attached to application' });
    if (url.includes('/Application/') && (opts.method || 'GET') === 'GET') return json({ objects: [] });
    if (url.includes('/Application/')) return json({ app_id: 'APP1' }, 201);
    if (url.includes('/Endpoint/') && (opts.method || 'GET') === 'GET') return json({ objects: [{ endpoint_id: 'EP1', username: 'testagent123' }] });
    if (url.includes('/Endpoint/')) return json({ message: 'changed' }, 202);
    if (url.includes('/Recording/?call_uuid=')) {
      // Simulates the filter being ignored upstream: returns someone else's call first.
      return json({ objects: [
        { recording_id: 'other', call_uuid: 'someone-else', recording_url: 'https://media.vobiz.test/other.mp3' },
        { recording_id: 'rec-1', call_uuid: 'call-1', recording_url: 'https://media.vobiz.test/rec-1.mp3' },
      ] });
    }
    if (url.includes('/Recording/rec-1/')) return json({ recording_id: 'rec-1', recording_url: 'https://media.vobiz.test/rec-1.mp3' });
    if (url.includes('/Recording/')) return json({ objects: [{ recording_id: 'rec-1', call_uuid: 'call-1', add_time: 't', rounded_recording_duration: 9 }] });
    return json({}, 404);
  }
  if (url.startsWith('https://media.vobiz.test/')) {
    return new Response(`AUDIO:${url.split('/').pop()}`, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (url.startsWith('https://acme.zendesk.com/')) return json({ ticket: { id: 42 } });
  return json({ unexpected: url }, 599);
};
