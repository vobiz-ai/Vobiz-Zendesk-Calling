const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { syncCallToZendesk, appendTranscription } = require('./zendeskService');

const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../zendesk-app/assets')));

// Enable CORS for frontend Zendesk integration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  next();
});

const PORT = process.env.PORT || 8092;
const VOBIZ_AUTH_ID = process.env.VOBIZ_AUTH_ID;
const VOBIZ_AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN;
const VOBIZ_FROM_NUMBER = process.env.VOBIZ_FROM_NUMBER;

// Environment fallbacks for Zendesk REST API access
const DEFAULT_ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const DEFAULT_ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const DEFAULT_ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

/**
 * Escape a value for safe interpolation into XML.
 *
 * `fromNumber` and `inboundNumber` reach the VXML webhook straight from a
 * client request. Interpolating them raw let a caller inject arbitrary verbs
 * into the call flow, e.g. fromNumber='"><Speak>...</Speak><x y="'.
 */
function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[<>&'"]/g, ch => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[ch]));
}

/** Escape for interpolation into an HTML document body. */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[<>&"]/g, ch => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'
  }[ch]));
}

/** Accept only E.164-ish dialable strings in call routing positions. */
function isDialable(value) {
  return typeof value === 'string' && /^\+?[0-9]{3,20}$/.test(value.trim());
}

/*
 * Sealed recording tokens.
 *
 * A recording link is written into a Zendesk ticket, where it is readable by
 * every agent, every ticket export, and every audit log, forever. Earlier
 * builds put `?authId=...&authToken=...` directly in that URL, which published
 * the account's API credentials to all of them.
 *
 * Instead the credentials are sealed into an opaque token with AES-256-GCM and
 * a short expiry. The ticket carries the token; only this backend can open it.
 *
 * Set RECORDING_TOKEN_SECRET so tokens stay valid across restarts. Without it a
 * random key is generated at boot and previously-issued links stop resolving.
 */
const RECORDING_TOKEN_TTL_MS = Number(process.env.RECORDING_TOKEN_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const RECORDING_TOKEN_KEY = process.env.RECORDING_TOKEN_SECRET
  ? crypto.createHash('sha256').update(process.env.RECORDING_TOKEN_SECRET).digest()
  : crypto.randomBytes(32);

if (!process.env.RECORDING_TOKEN_SECRET) {
  console.warn('[VoBiz Backend] RECORDING_TOKEN_SECRET is not set - recording links will stop working after a restart.');
}

function sealRecordingToken(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', RECORDING_TOKEN_KEY, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, exp: Date.now() + RECORDING_TOKEN_TTL_MS }), 'utf8'),
    cipher.final()
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function openRecordingToken(token) {
  try {
    const raw = Buffer.from(String(token), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', RECORDING_TOKEN_KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    );
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null; // tampered, truncated, or sealed with a different key
  }
}

// Load agents.json helper
function getAgents() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'agents.json'), 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[VoBiz Backend] Error reading agents.json:', err);
    return {};
  }
}

// GET /agent/:agentId
app.get('/agent/:agentId', (req, res) => {
  const agents = getAgents();
  let agent = agents[req.params.agentId];
  if (!agent) {
    // Dynamic fallback for custom extensions / usernames passed from softphone UI
    const defaultAgent = agents['test-agent'] || {};
    agent = {
      sipUser: req.params.agentId.includes('agent') ? req.params.agentId : (defaultAgent.sipUser || 'agentjohn403814661276504964978078'),
      sipPassword: defaultAgent.sipPassword || 'secret_password',
      displayName: `Agent (${req.params.agentId})`
    };
  }
  res.json(agent);
});

// GET /numbers
app.get('/numbers', async (req, res) => {
  const authId = req.query.authId || req.headers['x-auth-id'] || VOBIZ_AUTH_ID;
  const authToken = req.query.authToken || req.headers['x-auth-token'] || VOBIZ_AUTH_TOKEN;

  if (!authId || !authToken) {
    return res.status(400).json({ error: 'Missing VoBiz credentials (authId, authToken)', numbers: [] });
  }

  try {
    console.log(`[VoBiz Backend] Fetching phone numbers dynamically from VoBiz API for Auth ID: ${authId}`);
    const vobizUrl = `https://api.vobiz.ai/api/v1/Account/${authId}/numbers?per_page=1000&limit=1000`;
    const response = await fetch(vobizUrl, {
      method: 'GET',
      headers: {
        'X-Auth-ID': authId,
        'X-Auth-Token': authToken,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      let rawNumbers = data.items || data.numbers || data.objects || (Array.isArray(data) ? data : []);
      let parsedNumbers = rawNumbers.map(n => typeof n === 'string' ? n : (n.e164 || n.number || n.phone_number || n.alias)).filter(Boolean);

      // Remove duplicates while preserving order
      parsedNumbers = Array.from(new Set(parsedNumbers));
      cachedAccountNumbers = parsedNumbers;

      return res.json({ numbers: parsedNumbers, source: 'vobiz_api', count: parsedNumbers.length });
    } else {
      console.warn(`[VoBiz Backend] Numbers API returned ${response.status}`);
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ numbers: [], error: errData.error || 'Failed to fetch numbers from VoBiz API' });
    }
  } catch (err) {
    console.error('[VoBiz Backend] Failed to fetch numbers from VoBiz API:', err.message);
    return res.status(500).json({ numbers: [], error: err.message });
  }
});

let cachedAccountNumbers = [];

// POST /start-call
app.post('/start-call', async (req, res) => {
  const { to, agentId, authId, authToken, fromNumber } = req.body;
  if (!to || !agentId) {
    return res.status(400).json({ error: 'Missing required parameters: to, agentId' });
  }

  const agents = getAgents();
  let agent = agents[agentId];
  if (!agent) {
    const defaultAgent = agents['test-agent'] || {};
    agent = {
      sipUser: agentId.includes('agent') ? agentId : (defaultAgent.sipUser || 'agentjohn403814661276504964978078'),
      sipPassword: defaultAgent.sipPassword || 'secret_password',
      displayName: `Agent (${agentId})`
    };
  }

  const effectiveAuthId = authId || req.headers['x-auth-id'] || VOBIZ_AUTH_ID;
  const effectiveAuthToken = authToken || req.headers['x-auth-token'] || VOBIZ_AUTH_TOKEN;
  const effectiveFromNumber = fromNumber || VOBIZ_FROM_NUMBER;

  if (!effectiveAuthId || !effectiveAuthToken || !effectiveFromNumber) {
    console.error('[VoBiz Backend] Call start failed: missing authId, authToken, or fromNumber');
    return res.status(400).json({ error: 'Missing required VoBiz credentials or Caller ID. Please authenticate via the Zendesk App.' });
  }

  // Attempt to read the public tunnel URL dynamically
  let tunnelUrl = '';
  try {
    const tunnelUrlPath = path.join(__dirname, 'tunnel-url.txt');
    if (fs.existsSync(tunnelUrlPath)) {
      tunnelUrl = fs.readFileSync(tunnelUrlPath, 'utf8').trim();
    }
  } catch (e) {
    console.warn('[VoBiz Backend] Could not read tunnel-url.txt, fallback to request headers:', e.message);
  }

  if (!tunnelUrl) {
    tunnelUrl = `${req.protocol}://${req.get('host')}`;
  }

  console.log(`[VoBiz Backend] Call start triggered by Agent: "${agentId}" -> Customer: "${to}" | Outbound Caller ID: "${effectiveFromNumber}" (Auth ID: ${effectiveAuthId})`);
  
  // Format the answer URL to dial the agent next
  const answerUrl = `${tunnelUrl}/call-answer?agentId=${encodeURIComponent(agentId)}&inboundNumber=${encodeURIComponent(req.body.inboundNumber || '')}&fromNumber=${encodeURIComponent(effectiveFromNumber || '')}`;
  console.log(`[VoBiz Backend] Vobiz webhook Callback URL: ${answerUrl}`);

  try {
    const vobizUrl = `https://api.vobiz.ai/api/v1/Account/${effectiveAuthId}/Call/`;
    const response = await fetch(vobizUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-ID': effectiveAuthId,
        'X-Auth-Token': effectiveAuthToken
      },
      body: JSON.stringify({
        from: effectiveFromNumber,
        to: to, // Dial customer first
        answer_url: answerUrl,
        record: 'true'
      })
    });

    const result = await response.json();
    console.log('[VoBiz Backend] Call API response from VoBiz:', result);
    
    if (!response.ok) {
      return res.status(response.status).json(result);
    }
    
    res.json(result);
  } catch (error) {
    console.error('[VoBiz Backend] Failed to initiate call:', error);
    res.status(500).json({ error: error.message });
  }
});

const handleCallAnswer = (req, res) => {
  const agentId = req.query.agentId || req.body.agentId;
  const inboundNumber = req.query.inboundNumber || req.body.inboundNumber;
  const fromNumber = req.query.fromNumber || req.body.fromNumber;
  const agents = getAgents();
  const agent = agents[agentId];

  let dialContent = '';
  const isPstnNumber = isDialable(inboundNumber) && inboundNumber !== 'webrtc';
  // If the numbers cache has never been warmed (e.g. straight after a restart)
  // we cannot tell an account DID from an external number. Treating an account
  // DID as external makes the platform dial its own inbound number, which
  // loops. Route to the agent's endpoint instead, which is always safe.
  const cacheWarm = cachedAccountNumbers.length > 0;
  const isVirtualAccountDid = isPstnNumber && (!cacheWarm || cachedAccountNumbers.includes(inboundNumber));

  if (isPstnNumber && !isVirtualAccountDid) {
    console.log(`[VoBiz Webhook] Customer answered. Bridging to external PSTN phone: "${inboundNumber}"`);
    dialContent = `<Number>${escapeXml(inboundNumber)}</Number>`;
  } else {
    const cleanSipUsername = ((agent && agent.sipUser) || 'agentjohn403814661276504964978078').replace(/^sip:/, '').split('@')[0];
    if (isVirtualAccountDid) {
      console.log(`[VoBiz Webhook] Inbound number "${inboundNumber}" is an Account Virtual DID. Automatically routing to WebRTC SIP User: "${cleanSipUsername}"`);
    } else {
      console.log(`[VoBiz Webhook] Customer answered. Bridging to WebRTC SIP User: "${cleanSipUsername}"`);
    }
    dialContent = `<User>${escapeXml(cleanSipUsername)}</User>`;
  }

  res.set('Content-Type', 'text/xml');
  // Only a dialable value may appear as the caller ID, and it is escaped even
  // then - this string lands inside an XML attribute the platform executes.
  const callerAttr = isDialable(fromNumber) ? ` callerId="${escapeXml(fromNumber.trim())}"` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="true" redirect="false"${callerAttr}>
    ${dialContent}
  </Dial>
</Response>`.trim();
  
  res.send(xml);
};

app.get('/call-answer', handleCallAnswer);
app.post('/call-answer', handleCallAnswer);

// POST /hangup-call (REST Hangup trigger)
app.post('/hangup-call', async (req, res) => {
  const { callUuid, authId, authToken } = req.body;
  const effectiveAuthId = authId || req.headers['x-auth-id'] || VOBIZ_AUTH_ID;
  const effectiveAuthToken = authToken || req.headers['x-auth-token'] || VOBIZ_AUTH_TOKEN;

  if (!callUuid) {
    return res.json({ ok: true, message: 'SIP BYE handled client-side' });
  }

  try {
    console.log(`[VoBiz Backend] Force hanging up call UUID: ${callUuid}`);
    const vobizUrl = `https://api.vobiz.ai/api/v1/Account/${effectiveAuthId}/Call/${callUuid}/`;
    const response = await fetch(vobizUrl, {
      method: 'DELETE',
      headers: {
        'X-Auth-ID': effectiveAuthId,
        'X-Auth-Token': effectiveAuthToken,
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json().catch(() => ({ message: 'Call terminated' }));
    // Report the real outcome. Returning ok:true on a failed hangup left the
    // caller believing the call had ended while it was still up and billing.
    if (!response.ok) {
      console.warn(`[VoBiz Backend] Hangup rejected by VoBiz (${response.status}):`, result);
      return res.status(response.status).json({ ok: false, error: 'Vobiz rejected the hangup', result });
    }
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('[VoBiz Backend] Hangup REST call failed:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /sync-call
 * Option B: Talk Partner Edition (TPE) call ticket / voice comment sync, with Option A fallback.
 */
app.post('/sync-call', async (req, res) => {
  try {
    const {
      subdomain = DEFAULT_ZENDESK_SUBDOMAIN,
      email = DEFAULT_ZENDESK_EMAIL,
      apiToken = DEFAULT_ZENDESK_API_TOKEN,
      ticketId,
      fromNumber,
      toNumber,
      duration,
      recordingUrl,
      callDirection,
      notes,
      requesterId
    } = req.body;

    if (!subdomain) {
      return res.status(400).json({
        error: 'Missing Zendesk subdomain. Provide subdomain in request payload or configure ZENDESK_SUBDOMAIN in backend .env'
      });
    }

    let effectiveRecordingUrl = recordingUrl || '';
    const authId = req.body.authId || req.headers['x-auth-id'] || VOBIZ_AUTH_ID;
    const authToken = req.body.authToken || req.headers['x-auth-token'] || VOBIZ_AUTH_TOKEN;
    const callUuid = req.body.callUuid;

    // Read public tunnel URL dynamically
    let tunnelUrl = '';
    try {
      const tunnelUrlPath = path.join(__dirname, 'tunnel-url.txt');
      if (fs.existsSync(tunnelUrlPath)) {
        tunnelUrl = fs.readFileSync(tunnelUrlPath, 'utf8').trim();
      }
    } catch (e) {}
    if (!tunnelUrl) tunnelUrl = `${req.protocol}://${req.get('host')}`;

    if (callUuid && authId && authToken) {
      // The resulting URL is written into a Zendesk ticket. Never put the
      // account credentials in it - seal them into an expiring token instead.
      const token = sealRecordingToken({ authId, authToken, callUuid });
      effectiveRecordingUrl = `${tunnelUrl}/play-recording?token=${encodeURIComponent(token)}`;
    } else if (!effectiveRecordingUrl && callUuid && authId) {
      effectiveRecordingUrl = `https://api.vobiz.ai/api/v1/Account/${authId}/Recording/${callUuid}/`;
    }

    console.log(`[VoBiz Backend] Syncing call log for ticket: ${ticketId || 'NEW'}, Direction: ${callDirection}, Duration: ${duration}s, Recording: ${effectiveRecordingUrl || 'None'}`);

    const result = await syncCallToZendesk({
      subdomain,
      email,
      apiToken,
      ticketId,
      fromNumber: fromNumber || VOBIZ_FROM_NUMBER,
      toNumber,
      duration,
      recordingUrl: effectiveRecordingUrl,
      callDirection,
      notes,
      requesterId
    });

    res.json(result);
  } catch (error) {
    console.error('[VoBiz Backend] Failed to sync call to Zendesk:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /play-recording
 * Proxies call recording requests to VoBiz API with full authentication headers,
 * streaming the audio directly to the browser for zero-auth media playback.
 */
app.get('/play-recording', async (req, res) => {
  // Preferred: an opaque sealed token, as minted by /sync-call.
  const sealed = req.query.token ? openRecordingToken(req.query.token) : null;
  if (req.query.token && !sealed) {
    return res.status(403).send('This recording link is invalid or has expired.');
  }

  const { authId, authToken, callUuid } = sealed || req.query;
  const effectiveAuthId = authId || VOBIZ_AUTH_ID;
  const effectiveAuthToken = authToken || VOBIZ_AUTH_TOKEN;

  if (!effectiveAuthId || !effectiveAuthToken || !callUuid) {
    return res.status(400).send('Missing required parameters: token, or callUuid with credentials.');
  }

  try {
    console.log(`[VoBiz Recording Proxy] Fetching audio stream for Call UUID: ${callUuid} (Auth ID: ${effectiveAuthId})`);
    
    let targetAudioUrl = `https://api.vobiz.ai/api/v1/Account/${effectiveAuthId}/Recording/${callUuid}/`;
    
    let vobizRes = await fetch(targetAudioUrl, {
      method: 'GET',
      headers: {
        'X-Auth-ID': effectiveAuthId,
        'X-Auth-Token': effectiveAuthToken
      }
    });

    if (!vobizRes.ok) {
      const listUrl = `https://api.vobiz.ai/api/v1/Account/${effectiveAuthId}/Recording/?call_uuid=${callUuid}`;
      const listRes = await fetch(listUrl, {
        method: 'GET',
        headers: {
          'X-Auth-ID': effectiveAuthId,
          'X-Auth-Token': effectiveAuthToken
        }
      });

      if (listRes.ok) {
        const listData = await listRes.json();
        const items = listData.items || listData.objects || (Array.isArray(listData) ? listData : []);
        if (items.length > 0) {
          const recordingObj = items[0];
          const directFileUrl = recordingObj.recording_url || recordingObj.url || recordingObj.file;
          if (directFileUrl) {
            vobizRes = await fetch(directFileUrl, {
              method: 'GET',
              headers: {
                'X-Auth-ID': effectiveAuthId,
                'X-Auth-Token': effectiveAuthToken
              }
            });
          }
        }
      }
    }

    if (vobizRes.ok) {
      const contentType = vobizRes.headers.get('content-type') || 'audio/mpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline; filename="recording.mp3"');
      
      const buffer = await vobizRes.buffer();
      return res.send(buffer);
    } else {
      const errText = await vobizRes.text().catch(() => '');
      console.warn(`[VoBiz Recording Proxy] VoBiz API error (${vobizRes.status}):`, errText);
      
      res.setHeader('Content-Type', 'text/html');
      // 404, not 200: an <audio> element or fetch must be able to tell that
      // there is no media here rather than receiving a "successful" HTML page.
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>VoBiz Call Recording</title>
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
            <p>This call was disconnected before an active conversation took place (Duration: 0s). VoBiz automatically creates recordings once a live call is connected for more than 5 seconds.</p>
            <div class="badge">Call UUID: ${escapeHtml(callUuid)}</div>
          </div>
        </body>
        </html>
      `);
    }
  } catch (err) {
    console.error('[VoBiz Recording Proxy] Error streaming audio:', err);
    return res.status(500).send(`Server error streaming recording: ${err.message}`);
  }
});

/**
 * POST /transcription-ready
 * Appends full VoBiz / Vapi conversation transcript to the Zendesk ticket as a private internal note.
 */
app.post('/transcription-ready', async (req, res) => {
  try {
    const {
      subdomain = DEFAULT_ZENDESK_SUBDOMAIN,
      email = DEFAULT_ZENDESK_EMAIL,
      apiToken = DEFAULT_ZENDESK_API_TOKEN,
      ticketId,
      transcript,
      callId
    } = req.body;

    if (!subdomain || !ticketId || !transcript) {
      return res.status(400).json({
        error: 'Missing required parameters: ticketId, transcript, subdomain'
      });
    }

    console.log(`[VoBiz Backend] Received transcription-ready event for Zendesk ticket #${ticketId}`);

    const result = await appendTranscription({
      subdomain,
      email,
      apiToken,
      ticketId,
      transcript,
      callId
    });

    res.json(result);
  } catch (error) {
    console.error('[VoBiz Backend] Failed to append transcription to Zendesk ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
});
