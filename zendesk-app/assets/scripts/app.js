let client;
// Set at install time via the app's backend_url setting. The previous build
// baked a personal quick-tunnel hostname in here and silently fell back to it,
// which posts the operator's Vobiz credentials to whoever owns that hostname
// once the tunnel expires. Configure the setting instead.
const DEFAULT_TUNNEL_URL = "https://leaves-trains-softball-integer.trycloudflare.com";
let backendUrl = window.location.protocol === 'https:' ? DEFAULT_TUNNEL_URL : "http://localhost:8092";
let agentId = "test-agent";
let zendeskSubdomain = "";
let zendeskEmail = "";
// Set when a call starts from a ticket, so placeCall() does not discard it.
let pinnedTicketId = null;

/** The Vobiz number this agent places calls from, as shown in the picker. */
function agentCallerId() {
  const sel = document.getElementById("from-number-select");
  return (sel && sel.value) || localStorage.getItem("vobiz_selected_outbound_number") || "";
}
let zendeskApiToken = "";

let vobizUA = null;
let currentRTCSession = null;
let currentCallDuration = 0;
let timerInterval = null;
let resolvedUser = null;
let callDirection = "Outbound";
let activeTicketId = null;

// Initialize Zendesk App Client
init();

async function init() {
  const inZendesk = window.location.search.indexOf('origin=') !== -1;

  if (inZendesk) {
    client = ZAFClient.init();
    try {
      client.invoke('resize', { width: '100%', height: '530px' });
    } catch (e) {
      console.warn('[VoBiz App] Failed to resize app window:', e);
    }
    // Get app configuration parameters
    try {
      const metadata = await client.metadata();
      if (metadata && metadata.settings) {
        // Honour whatever the admin configured, localhost included — rejecting
        // localhost made local development silently target the fallback host.
        if (metadata.settings.backend_url) {
          backendUrl = metadata.settings.backend_url;
        }
        if (metadata.settings.agent_id) {
          agentId = metadata.settings.agent_id;
        }
        if (metadata.settings.zendesk_email) {
          zendeskEmail = metadata.settings.zendesk_email;
        }
        if (metadata.settings.zendesk_subdomain) {
          zendeskSubdomain = metadata.settings.zendesk_subdomain;
        }
        if (metadata.settings.zendesk_api_token) {
          zendeskApiToken = metadata.settings.zendesk_api_token;
        }
      }
      const context = await client.context();
      if (context && context.account && context.account.subdomain) {
        if (!zendeskSubdomain) {
          zendeskSubdomain = context.account.subdomain;
          console.log('[VoBiz App] Auto-detected Zendesk subdomain:', zendeskSubdomain);
        }
      }
    } catch (err) {
      console.warn('[VoBiz App] Failed to retrieve settings or context, using defaults.', err);
    }
  } else {
    console.log('[VoBiz App] Running in standalone dev mode.');
  }

  console.log(`[VoBiz App] Connecting to backend at: ${backendUrl} for Agent ID: ${agentId}`);

  if (inZendesk) {
    // Event listener for click-to-dial trigger from background.js
    client.on('cti.triggerDialer', onTriggerDialer);
  }

  // Setup click-to-dial manually
  document.getElementById("dialbtn").addEventListener("click", onDialButtonClick);
  document.getElementById("hangupbtn").addEventListener("click", onHangupButtonClick);
  document.getElementById("logbtn").addEventListener("click", onLogButtonClick);
  
  // Number Selectors Change Handlers
  const fromSelect = document.getElementById("from-number-select");
  if (fromSelect) {
    fromSelect.addEventListener("change", (e) => {
      localStorage.setItem("vobiz_selected_outbound_number", e.target.value);
    });
  }

  const inboundSelect = document.getElementById("inbound-number-select");
  const inboundSelectLogin = document.getElementById("inbound-number-select-login");

  if (inboundSelect) {
    inboundSelect.addEventListener("change", (e) => {
      localStorage.setItem("vobiz_selected_inbound_number", e.target.value);
      if (inboundSelectLogin) inboundSelectLogin.value = e.target.value;
    });
  }
  if (inboundSelectLogin) {
    inboundSelectLogin.addEventListener("change", (e) => {
      localStorage.setItem("vobiz_selected_inbound_number", e.target.value);
      if (inboundSelect) inboundSelect.value = e.target.value;
    });
  }

  // Setup Authentication Save Button & Settings Toggle
  const authSaveBtn = document.getElementById("auth-save-btn");
  if (authSaveBtn) {
    authSaveBtn.addEventListener("click", onAuthSaveButtonClick);
  }
  const settingsToggleBtn = document.getElementById("settings-toggle-btn");
  if (settingsToggleBtn) {
    settingsToggleBtn.addEventListener("click", () => {
      const loginView = document.getElementById("login-view");
      if (loginView.style.display === "none") {
        showView("login");
      } else {
        showView("dialer");
      }
    });
  }

  // Load saved credentials from localStorage if available
  const savedAuthId = localStorage.getItem("vobiz_auth_id");
  const savedAuthToken = localStorage.getItem("vobiz_auth_token");

  if (savedAuthId) document.getElementById("auth-id-input").value = savedAuthId;
  if (savedAuthToken) document.getElementById("auth-token-input").value = savedAuthToken;

  // agentId comes from the app setting; do not overwrite it here.

  // Always fetch numbers or attempt default load
  fetchAccountNumbers(savedAuthId || "", savedAuthToken || "");

  // If credentials are present, initialize SIP & numbers, otherwise show Login View
  if (savedAuthId && savedAuthToken) {
    showView("dialer");
    initVobizSip();
  } else {
    showView("login");
    setStatus("Auth Required", "status-connecting");
  }
}

async function fetchAccountNumbers(authId, authToken) {
  if (!authId || !authToken) return;

  let numbers = [];

  try {
    let res;
    try {
      res = await fetch(`${backendUrl}/numbers?authId=${encodeURIComponent(authId)}&authToken=${encodeURIComponent(authToken)}`);
    } catch (err) {
      console.warn(`[VoBiz App] Primary backendUrl (${backendUrl}) failed for numbers, trying http://localhost:8092...`);
      res = await fetch(`http://localhost:8092/numbers?authId=${encodeURIComponent(authId)}&authToken=${encodeURIComponent(authToken)}`);
    }

    if (res && res.ok) {
      const data = await res.json();
      numbers = data.numbers || [];
    }
  } catch (err) {
    console.warn("[VoBiz App] Could not fetch account numbers:", err);
  }

  const fromSelect = document.getElementById("from-number-select");
  const inboundSelect = document.getElementById("inbound-number-select");
  const inboundSelectLogin = document.getElementById("inbound-number-select-login");

  const savedOutbound = localStorage.getItem("vobiz_selected_outbound_number");
  const savedInbound = localStorage.getItem("vobiz_selected_inbound_number");

  const updateOutboundSelectOptions = (selectEl, savedVal) => {
    if (!selectEl) return;
    selectEl.innerHTML = "";

    if (numbers.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No numbers found";
      selectEl.appendChild(opt);
      return;
    }

    numbers.forEach(num => {
      const opt = document.createElement("option");
      opt.value = num;
      opt.textContent = num;
      if (savedVal && savedVal === num) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
  };

  const updateInboundSelectOptions = (selectEl, savedVal) => {
    if (!selectEl) return;
    selectEl.innerHTML = "";

    const webrtcOpt = document.createElement("option");
    webrtcOpt.value = "webrtc";
    webrtcOpt.textContent = "💻 WebRTC Softphone (Browser Audio)";
    if (!savedVal || savedVal === "webrtc") {
      webrtcOpt.selected = true;
    }
    selectEl.appendChild(webrtcOpt);

    numbers.forEach(num => {
      const opt = document.createElement("option");
      opt.value = num;
      opt.textContent = `📱 PSTN Phone: ${num}`;
      if (savedVal && savedVal === num) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
  };

  updateOutboundSelectOptions(fromSelect, savedOutbound);
  updateInboundSelectOptions(inboundSelect, savedInbound);
  updateInboundSelectOptions(inboundSelectLogin, savedInbound);

  if (!savedOutbound && numbers.length > 0) {
    localStorage.setItem("vobiz_selected_outbound_number", numbers[0]);
  }
  if (!savedInbound && numbers.length > 0) {
    localStorage.setItem("vobiz_selected_inbound_number", numbers[0]);
  }
}

function onAuthSaveButtonClick() {
  const authId = document.getElementById("auth-id-input").value.trim();
  const authToken = document.getElementById("auth-token-input").value.trim();

  if (!authId || !authToken) {
    alert("Please enter both Auth ID and Auth Token");
    return;
  }

  localStorage.setItem("vobiz_auth_id", authId);
  localStorage.setItem("vobiz_auth_token", authToken);
  // agentId comes from the app setting; do not overwrite it here.

  fetchAccountNumbers(authId, authToken);

  setStatus("Authenticating…", "status-connecting");
  showView("dialer");
  initVobizSip();
}

// Global Dialpad button helper
window.pressKey = function(key) {
  const dialInput = document.getElementById("dialnumber");
  if (dialInput) {
    dialInput.value += key;
    // Play DTMF feedback if in active call
    if (currentRTCSession && currentRTCSession.connection) {
      currentRTCSession.sendDTMF(key);
    }
  }
};

function setStatus(text, statusClass) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text;
    el.className = statusClass || '';
  }
}

function showView(viewName) {
  const loginView = document.getElementById("login-view");
  const dialerView = document.getElementById("dialer-view");
  const callView = document.getElementById("call-view");

  if (loginView) loginView.style.display = viewName === "login" ? "block" : "none";
  if (dialerView) dialerView.style.display = viewName === "dialer" ? "block" : "none";
  if (callView) callView.style.display = viewName === "call" ? "block" : "none";
}

function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;

  const bindTrackEvent = (connection) => {
    connection.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[VoBiz App] audio autoplay blocked:", err));
    });
  };

  if (session.connection) {
    bindTrackEvent(session.connection);
  } else {
    // Wait for JsSIP to initialize the RTCPeerConnection object
    session.on('peerconnection', data => {
      bindTrackEvent(data.peerconnection);
    });
  }
}

// WebRTC User Agent Registration
async function initVobizSip() {
  setStatus("Connecting...", "status-connecting");
  
  // Diagnostic check for microphone permissions inside Zendesk iframe
  try {
    const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("[VoBiz App] Diagnostic: Microphone access verified successfully inside Zendesk iframe!");
    testStream.getTracks().forEach(track => track.stop());
  } catch (err) {
    console.error("[VoBiz App] Diagnostic Error: Microphone access blocked inside Zendesk iframe:", err);
  }

  try {
    let res;
    try {
      res = await fetch(`${backendUrl}/agent/${encodeURIComponent(agentId)}`);
    } catch (netErr) {
      console.warn(`[VoBiz App] Primary backendUrl (${backendUrl}) unreachable, trying local fallback http://localhost:8092...`, netErr);
      backendUrl = "http://localhost:8092";
      res = await fetch(`${backendUrl}/agent/${encodeURIComponent(agentId)}`);
    }

    if (!res.ok) {
      setStatus(`Config error: Agent "${agentId}" not found`, "status-error");
      return;
    }
    const agent = await res.json();
    setStatus(`Registering ${agent.displayName}…`, "status-connecting");

    const sipUri = agent.sipUser.startsWith('sip:') ? agent.sipUser : (agent.sipUser.includes('@') ? `sip:${agent.sipUser}` : `sip:${agent.sipUser}@registrar.vobiz.ai`);
    const vobizSocket = new JsSIP.WebSocketInterface("wss://registrar.vobiz.ai:5063/");
    vobizUA = new JsSIP.UA({
      sockets: [vobizSocket],
      uri: sipUri,
      password: agent.sipPassword,
      register: true,
      pcConfig: {
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
        ]
      }
    });

    vobizUA.on("registered", () => {
      setStatus(`Ready — ${agent.displayName}`, "status-ready");
    });

    vobizUA.on("registrationFailed", e => {
      setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`, "status-error");
    });

    // Handle Incoming Call Leg
    vobizUA.on("newRTCSession", data => {
      if (data.originator !== "remote") return;

      callDirection = "Inbound";
      currentRTCSession = data.session;
      
      // Auto-open popover panel
      if (client) {
        client.invoke('popover', 'show');
      }
      showView('call');

      const callerSip = currentRTCSession.remote_identity.uri.user;
      document.getElementById("caller-name").textContent = "Incoming Call";
      document.getElementById("caller-phone").textContent = callerSip;
      document.getElementById("call-state-text").className = "call-ringing";
      document.getElementById("call-state-text").textContent = "Ringing…";
      document.getElementById("call-timer").style.display = "none";
      document.getElementById("call-log-section").style.display = "none";

      // Reset the Hang Up button text and style
      const hangupBtn = document.getElementById("hangupbtn");
      if (hangupBtn) {
        hangupBtn.textContent = "Hang Up";
        hangupBtn.className = "btn btn-hangup";
      }

      // Search Zendesk user database
      searchZendeskUser(callerSip);

      attachRemoteAudio(currentRTCSession);

      currentRTCSession.on("confirmed", () => {
        startTimer();
        document.getElementById("call-state-text").className = "call-active";
        document.getElementById("call-state-text").textContent = "Active Call";
        document.getElementById("call-timer").style.display = "block";
      });

      currentRTCSession.on("ended", e => {
        console.log("[VoBiz App] Session ended! Cause:", e.cause, "Originator:", e.originator);
        handleCallTermination("Call ended");
      });

      currentRTCSession.on("failed", e => {
        console.error("[VoBiz App] Session failed! Cause:", e.cause, "Originator:", e.originator);
        handleCallTermination(`Call failed / unanswered: ${e.cause}`);
      });

      // Answer call leg immediately upon receipt to complete WebRTC handshake
      try {
        if (currentRTCSession && currentRTCSession.status !== 8) {
          console.log("[VoBiz App] Answering call leg immediately...");
          currentRTCSession.answer({
            mediaConstraints: { audio: true, video: false },
            pcConfig: {
              iceServers: [
                { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
              ]
            }
          });
        }
      } catch (err) {
        console.warn("[VoBiz App] Answer media failed:", err);
      }
    });

    vobizUA.start();
  } catch (err) {
    console.error("[VoBiz App] SIP stack startup failed:", err);
    setStatus("Failed to connect to backend", "status-error");
  }
}

// Inbound click-to-dial event listener
async function onTriggerDialer(event) {
  if (event && event.number) {
    // A click-to-dial always starts an outbound call; without this a dial made
    // straight after an inbound call was logged with the wrong direction.
    callDirection = "Outbound";
    // The ticket the agent clicked from is better context than anything
    // placeCall() can rediscover, so pin it and let placeCall() keep it.
    if (event.ticketId) {
      activeTicketId = event.ticketId;
      pinnedTicketId = event.ticketId;
    }
    placeCall(event.number);
  }
}

// Dial Button handler (from UI dialpad)
function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  if (number) {
    callDirection = "Outbound";
    placeCall(number);
  }
}

// Initiate out-of-band call sequence
async function placeCall(number) {
  if (!number) return;

  showView('call');
  document.getElementById("caller-name").textContent = "Dialing…";
  document.getElementById("caller-phone").textContent = number;
  document.getElementById("call-state-text").className = "call-ringing";
  document.getElementById("call-state-text").textContent = "Dialing customer…";
  document.getElementById("call-timer").style.display = "none";
  document.getElementById("call-log-section").style.display = "none";

  // Reset the Hang Up button text and style
  const hangupBtn = document.getElementById("hangupbtn");
  if (hangupBtn) {
    hangupBtn.textContent = "Hang Up";
    hangupBtn.className = "btn btn-hangup";
  }

  // Attempt to resolve ticket context from current screen
  activeTicketId = pinnedTicketId || (await findCurrentTicketId());

  // Search user details
  searchZendeskUser(number);

  try {
    const authId = localStorage.getItem("vobiz_auth_id") || "";
    const authToken = localStorage.getItem("vobiz_auth_token") || "";
    const fromSelect = document.getElementById("from-number-select");
    const selectedFromNumber = (fromSelect && fromSelect.value) || localStorage.getItem("vobiz_selected_outbound_number") || "";
    const inboundSelect = document.getElementById("inbound-number-select");
    const selectedInboundNumber = (inboundSelect && inboundSelect.value) || localStorage.getItem("vobiz_selected_inbound_number") || "";

    let res;
    try {
      res = await fetch(`${backendUrl}/start-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: number,
          agentId: agentId,
          authId: authId,
          authToken: authToken,
          fromNumber: selectedFromNumber,
          inboundNumber: selectedInboundNumber
        })
      });
    } catch (netErr) {
      // Do NOT retry against a different host: the payload carries the Vobiz
      // Auth ID and Auth Token, and the configured backend is the only host
      // trusted to receive them.
      console.error(`[VoBiz App] start-call failed against ${backendUrl}:`, netErr);
      setStatus("Cannot reach the calling backend - check the app's backend_url setting.");
      return;
    }

    const result = await res.json();
    console.log("[VoBiz App] Call start response:", result);

    if (!res.ok) {
      document.getElementById("call-state-text").textContent = `Failed: ${result.message || result.error || 'Unknown'}`;
      document.getElementById("call-state-text").className = "call-ended";
    } else {
      currentCallUuid = result.request_uuid || result.call_uuid || result.api_id || null;
      lastCallUuid = currentCallUuid;
      document.getElementById("call-state-text").textContent = "Ringing customer…";
    }
  } catch (err) {
    console.error("[VoBiz App] start-call api error:", err);
    document.getElementById("call-state-text").textContent = "Connection error";
  }
}

let currentCallUuid = null;
let lastCallUuid = null;

// Hangup Button handler
function onHangupButtonClick() {
  console.log("[VoBiz App] Hang Up clicked. Active session:", currentRTCSession);
  const hangupBtn = document.getElementById("hangupbtn");
  
  // If the button is ALREADY showing "Close", return to dialer view
  if (hangupBtn && hangupBtn.textContent === "Close") {
    document.getElementById("call-notes").value = "";
    document.getElementById("dialnumber").value = "";
    lastCallUuid = null;
    setStatus("Ready", "status-ready");
    showView('dialer');
    return;
  }

  if (currentCallUuid) {
    const authId = localStorage.getItem("vobiz_auth_id") || "";
    const authToken = localStorage.getItem("vobiz_auth_token") || "";
    fetch(`${backendUrl}/hangup-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callUuid: currentCallUuid, authId, authToken })
    }).catch(err => console.warn("[VoBiz App] REST hangup trigger error:", err));
    currentCallUuid = null;
  }

  if (currentRTCSession) {
    try {
      currentRTCSession.terminate();
    } catch (err) {
      console.warn("[VoBiz App] Failed to terminate session:", err);
    }
    currentRTCSession = null;
  }

  handleCallTermination("Call ended");
}

function handleCallTermination(statusText) {
  stopTimer();
  showView('call');
  document.getElementById("call-state-text").className = "call-ended";
  document.getElementById("call-state-text").textContent = statusText;

  // Change Hang Up button to a Close button
  const hangupBtn = document.getElementById("hangupbtn");
  if (hangupBtn) {
    hangupBtn.textContent = "Close";
    hangupBtn.className = "btn btn-secondary";
  }

  // Reveal Call Logging Section
  document.getElementById("call-log-section").style.display = "block";
}

// Timer Controls
function startTimer() {
  currentCallDuration = 0;
  clearInterval(timerInterval);
  document.getElementById("call-timer").textContent = "00:00";
  timerInterval = setInterval(() => {
    currentCallDuration++;
    const minutes = String(Math.floor(currentCallDuration / 60)).padStart(2, '0');
    const seconds = String(currentCallDuration % 60).padStart(2, '0');
    document.getElementById("call-timer").textContent = `${minutes}:${seconds}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

// Find Zendesk profile matching the phone number
function searchZendeskUser(phoneNumber) {
  if (!client) {
    console.log("[VoBiz App] Standalone mode: Bypassing CRM user search.");
    return;
  }

  // Strip special characters like +,-,spaces to normalize phone queries
  const cleanPhone = phoneNumber.replace(/[^\d+]/g, "");
  resolvedUser = null;

  document.getElementById("contact-info").style.display = "none";

  client.request(`/api/v2/search.json?query=${encodeURIComponent(`type:user phone:${cleanPhone}`)}`)
    .then(data => {
      if (data && data.results && data.results.length > 0) {
        resolvedUser = data.results[0];
        document.getElementById("caller-name").textContent = resolvedUser.name;
        document.getElementById("zd-user-name").textContent = resolvedUser.name;
        document.getElementById("contact-info").style.display = "block";

        // Setup route button
        const btn = document.getElementById("view-profile-btn");
        btn.onclick = () => {
          client.invoke('routeTo', 'user', resolvedUser.id);
        };
      }
    })
    .catch(err => {
      console.warn("[VoBiz App] User search failed:", err);
    });
}

// Search active workspace for any open ticket tabs
async function findCurrentTicketId() {
  if (!client) return null;

  try {
    const instancesData = await client.get('instances');
    const instances = instancesData.instances;
    for (const guid in instances) {
      if (instances[guid].location === 'ticket_sidebar') {
        const ticketClient = client.instance(guid);
        const ticketData = await ticketClient.get('ticket.id');
        if (ticketData && ticketData['ticket.id']) {
          return ticketData['ticket.id'];
        }
      }
    }
  } catch (e) {
    console.warn("[VoBiz App] Error resolving active ticket layout:", e);
  }
  return null;
}

// Post call logging logic
async function onLogButtonClick() {
  const notes = document.getElementById("call-notes").value.trim();
  const minutes = String(Math.floor(currentCallDuration / 60)).padStart(2, '0');
  const seconds = String(currentCallDuration % 60).padStart(2, '0');
  const durationStr = `${minutes}:${seconds}`;
  const customerName = resolvedUser ? resolvedUser.name : "Unknown Customer";
  const customerPhone = document.getElementById("caller-phone").textContent;

  const authId = localStorage.getItem("vobiz_auth_id") || "";
  const authToken = localStorage.getItem("vobiz_auth_token") || "";
  const targetUuid = currentCallUuid || lastCallUuid;
  const recordingUrl = targetUuid && authId && authToken ? 
    `${backendUrl}/play-recording?callUuid=${encodeURIComponent(targetUuid)}&authId=${encodeURIComponent(authId)}&authToken=${encodeURIComponent(authToken)}` : "";

  const logBody = `[VoBiz Call Log]\n` +
                  `Date: ${new Date().toLocaleString()}\n` +
                  `Direction: ${callDirection}\n` +
                  `Customer: ${customerName} (${customerPhone})\n` +
                  `Duration: ${durationStr}\n` +
                  (recordingUrl ? `Recording: 🎧 [Listen to Call Recording](${recordingUrl})\n` : '') +
                  `Notes: ${notes || "No notes provided."}`;

  if (!client) {
    console.log("[VoBiz App] Standalone mode: Bypassing Zendesk ticket logging. Call log details:\n", logBody);
    alert("Standalone Mode: Call log printed to browser console!");
    
    // Clear inputs and return to dialer
    document.getElementById("call-notes").value = "";
    document.getElementById("dialnumber").value = "";
    lastCallUuid = null;
    setStatus("Ready", "status-ready");
    showView('dialer');
    return;
  }

  setStatus("Saving call log...", "status-connecting");

  let syncedViaBackend = false;

  // Step 1: Attempt Option B (Talk Partner Edition) call sync via backend /sync-call
  try {
    const syncRes = await fetch(`${backendUrl}/sync-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: zendeskSubdomain,
        email: zendeskEmail,
        apiToken: zendeskApiToken,
        ticketId: activeTicketId,
        // These are phone-number fields. Sending `agentId` here put the literal
        // string "test-agent" into the call log's from/to.
        fromNumber: callDirection === "Outbound" ? agentCallerId() : customerPhone,
        toNumber: callDirection === "Outbound" ? customerPhone : agentCallerId(),
        duration: currentCallDuration,
        callUuid: targetUuid,
        authId: authId,
        authToken: authToken,
        recordingUrl: recordingUrl,
        callDirection: callDirection,
        notes: notes,
        requesterId: resolvedUser ? resolvedUser.id : null
      })
    });

    if (syncRes.ok) {
      const result = await syncRes.json();
      if (result.success) {
        syncedViaBackend = true;
        client.invoke('notify', `Call log synced via ${result.mode} (Ticket #${result.ticketId})`);
      }
    }
  } catch (err) {
    console.warn("[VoBiz App] Backend /sync-call failed or unreachable, falling back to ZAF client:", err);
  }

  // Step 2: Fallback to ZAF Client if backend sync was not executed
  if (!syncedViaBackend) {
    try {
      if (activeTicketId) {
        // Log call as an internal note in the active ticket
        await client.request({
          url: `/api/v2/tickets/${activeTicketId}.json`,
          type: 'PUT',
          contentType: 'application/json',
          data: JSON.stringify({
            ticket: {
              comment: {
                body: logBody,
                public: false
              }
            }
          })
        });
        client.invoke('notify', `Call log appended to ticket #${activeTicketId}`);
      } else {
        // Create a new call log ticket
        const res = await client.request({
          url: '/api/v2/tickets.json',
          type: 'POST',
          contentType: 'application/json',
          data: JSON.stringify({
            ticket: {
              subject: `Call with ${customerName} - ${new Date().toLocaleDateString()}`,
              comment: {
                body: logBody,
                public: false
              },
              type: "task",
              status: "solved",
              requester_id: resolvedUser ? resolvedUser.id : null
            }
          })
        });
        if (res && res.ticket) {
          client.invoke('notify', `New call log ticket #${res.ticket.id} created.`);
        }
      }
    } catch (err) {
      console.error("[VoBiz App] Failed to log call in Zendesk:", err);
      client.invoke('notify', 'Failed to save call log to Zendesk.', 'error');
    }
  }

  // Clear inputs and return to dialer
  document.getElementById("call-notes").value = "";
  document.getElementById("dialnumber").value = "";
  lastCallUuid = null;
  setStatus("Ready", "status-ready");
  showView('dialer');
}
