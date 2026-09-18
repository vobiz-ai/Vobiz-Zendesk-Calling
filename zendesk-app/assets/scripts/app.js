/** === Vobiz Calling — Zendesk Support CTI app ===
 *
 * A softphone that lives in the Zendesk top bar. It stays registered over SIP
 * while the panel is open, dials when the agent clicks Call or clicks a phone
 * number in Zendesk, logs calls to tickets, and displays recent recordings.
 *
 * THE BROWSER IS THE A LEG. This panel sends the SIP INVITE itself and the
 * backend answers with <Dial><Number>.
 */

const REGISTRAR_HOST = "registrar.vobiz.ai";

let client = null;
let backendUrl = "";
let agentId = "";
let registrarUrl = `wss://${REGISTRAR_HOST}:5063/`;
let zendeskSubdomain = "";

let sessionToken = "";
let vobizUA = null;
let currentRTCSession = null;
let agentIdentity = null;

// Calling requires BOTH an account session and a live SIP registration.
let accountReady = false;
let sipRegistered = false;

let callDirection = "Outbound";
let callDurationSeconds = 0;
let timerInterval = null;
let resolvedUser = null;
let activeTicketId = null;
let lastDialedNumber = "";
let lastCallRecord = null;

// ─── backend plumbing ────────────────────────────────────────────────────────

/**
 * Every backend call goes through here.
 * The ngrok-skip-browser-warning header suppresses the free-tier interstitial.
 */
async function backendFetch(pathname, options = {}) {
  const url = pathname.startsWith("http") ? pathname : `${backendUrl}${pathname}`;
  const headers = {
    "ngrok-skip-browser-warning": "1",
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

async function backendJson(pathname, options) {
  const res = await backendFetch(pathname, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${(options && options.method) || "GET"} ${pathname} failed (${res.status})`);
  }
  return data;
}

function normaliseSettings(raw) {
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  return Object.assign({}, ...raw.filter(Boolean));
}

// ─── boot ────────────────────────────────────────────────────────────────────

init();

async function init() {
  const inZendesk = typeof ZAFClient !== "undefined" && window.location.search.includes("origin=");

  if (inZendesk) {
    client = ZAFClient.init();
    try { await client.invoke("resize", { width: "100%", height: "560px" }); } catch { /* non-fatal */ }

    try {
      const metadata = await client.metadata();
      const settings = normaliseSettings(metadata && metadata.settings);
      backendUrl = String(settings.backend_url || "").trim().replace(/\/+$/, "");
      agentId = String(settings.agent_id || "").trim();
      if (settings.registrar_url) registrarUrl = String(settings.registrar_url).trim();

      const context = await client.context();
      zendeskSubdomain = (context && context.account && context.account.subdomain) || "";
    } catch (err) {
      console.warn("[Vobiz] Could not read app settings:", err);
    }
  } else {
    console.log("[Vobiz] Standalone dev mode — no ZAF client.");
    backendUrl = "http://localhost:8092";
    agentId = "test-agent";
  }

  if (!backendUrl || !agentId) {
    setStatus("Not configured — set the Backend URL and Agent Identity in this app's settings.", "error");
    return;
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(backendUrl);
  if (!/^https:\/\//i.test(backendUrl) && !isLocal) {
    setStatus("Backend URL must start with https:// — check this app's settings.", "error");
    return;
  }

  wireUi();

  if (inZendesk) {
    client.on("cti.triggerDialer", onTriggerDialer);
    client.on("voice.dialout", onTriggerDialer);
  }

  // Leave registrar cleanly on window close/refresh
  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch { /* ignore */ }
  });

  restoreAuthMode();
  if (authMode !== "sip") {
    await restoreVobizSession();
  }
}

function wireUi() {
  const loginBtn = document.getElementById("vobiz-login-btn");
  if (loginBtn) loginBtn.addEventListener("click", vobizLogin);

  const modeAccountTab = document.getElementById("mode-account-tab");
  if (modeAccountTab) modeAccountTab.addEventListener("click", () => setAuthMode("account"));

  const modeSipTab = document.getElementById("mode-sip-tab");
  if (modeSipTab) modeSipTab.addEventListener("click", () => setAuthMode("sip"));

  const sipConnectBtn = document.getElementById("sip-connect-btn");
  if (sipConnectBtn) sipConnectBtn.addEventListener("click", sipDirectConnect);

  const acceptBtn = document.getElementById("acceptbtn");
  if (acceptBtn) acceptBtn.addEventListener("click", acceptCall);

  const declineBtn = document.getElementById("declinebtn");
  if (declineBtn) declineBtn.addEventListener("click", declineCall);

  document.addEventListener("keydown", e => {
    if (!incomingPending) return;
    if (e.key === "Enter") {
      e.preventDefault();
      acceptCall();
    } else if (e.key === "Escape") {
      e.preventDefault();
      declineCall();
    }
  });

  const numSelect = document.getElementById("vobiz-number-select");
  if (numSelect) numSelect.addEventListener("change", vobizSelectNumber);

  const dialBtn = document.getElementById("dialbtn");
  if (dialBtn) dialBtn.addEventListener("click", onDialButtonClick);

  const hangupBtn = document.getElementById("hangupbtn");
  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);

  const setupInboundBtn = document.getElementById("setup-inbound-btn");
  if (setupInboundBtn) setupInboundBtn.addEventListener("click", setupInboundCalling);

  const refreshHistoryBtn = document.getElementById("refresh-history-btn");
  if (refreshHistoryBtn) refreshHistoryBtn.addEventListener("click", loadCallHistory);

  const dialInput = document.getElementById("dialnumber");
  if (dialInput) {
    dialInput.addEventListener("keydown", e => {
      if (e.key === "Enter") onDialButtonClick();
    });
  }
}

// ─── auth mode & SIP direct ──────────────────────────────────────────────────

const AUTH_MODE_KEY = "vobiz.authMode";
const SIP_CREDS_KEY = "vobiz.sipDirect";
let authMode = "account";

function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

function setAuthMode(mode) {
  authMode = mode === "sip" ? "sip" : "account";
  writeStore(AUTH_MODE_KEY, authMode);

  const isSip = authMode === "sip";
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  };
  show("mode-account", !isSip);
  show("mode-sip", isSip);
  show("step-caller-id", !isSip);

  const tab = (id, active) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-selected", String(active));
  };
  tab("mode-account-tab", !isSip);
  tab("mode-sip-tab", isSip);
}

function sipDirectCallerId() {
  const el = document.getElementById("sip-caller-id");
  return el ? el.value.trim() : "";
}

async function sipDirectConnect() {
  const username = (document.getElementById("sip-username") || {}).value?.trim() || "";
  const password = (document.getElementById("sip-password") || {}).value || "";
  const callerId = sipDirectCallerId();
  const remember = Boolean((document.getElementById("sip-remember") || {}).checked);

  if (!username || !password) {
    setLoginStatus("Enter the endpoint's SIP username and password.");
    return;
  }
  if (!callerId) {
    setLoginStatus("Enter the number to call from — carriers reject a call without one.");
    return;
  }

  writeStore(SIP_CREDS_KEY, remember ? { username, password, callerId } : null);

  const cleanUsername = username.includes("@") ? username.split("@")[0] : username;
  const sipUser = `${cleanUsername}@${REGISTRAR_HOST}`;
  setLoginStatus(`Signing in as ${cleanUsername}…`);

  try {
    await backendJson("/login-sip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sipUser: cleanUsername, callerId }),
    });
  } catch (err) {
    console.warn("[Vobiz] Backend /login-sip registration note:", err.message);
  }

  setDialEnabled(true);
  startSipUA(sipUser, password, cleanUsername);
}

function restoreAuthMode() {
  setAuthMode(readStore(AUTH_MODE_KEY) || "account");
  if (authMode !== "sip") return;

  const saved = readStore(SIP_CREDS_KEY);
  if (!saved || !saved.username) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
  set("sip-username", saved.username);
  set("sip-password", saved.password);
  set("sip-caller-id", saved.callerId);
  const box = document.getElementById("sip-remember");
  if (box) box.checked = true;
  if (saved.password && saved.callerId) {
    sipDirectConnect();
  }
}

// ─── session & auth ──────────────────────────────────────────────────────────

async function restoreVobizSession() {
  sessionToken = sessionStorage.getItem("vobiz_session_token") || "";
  try {
    const res = await backendFetch(`/session/${encodeURIComponent(agentId)}`);
    const session = await res.json().catch(() => ({}));
    if (session.loggedIn) {
      try { await backendJson("/setup", { method: "POST" }); } catch (e) { console.warn("[Vobiz] setup note:", e); }
      renderNumberOptions(session.numbers, session.from);
      setLoginStatus(`Logged in as ${session.authId} — calling from ${session.from}`);
      setDialEnabled(true);
      loadCallHistory();
      initVobizSip();
    } else {
      setDialEnabled(false);
      initVobizSip();
    }
  } catch (err) {
    console.warn("[Vobiz] Could not check login session:", err);
    initVobizSip();
  }
}

async function vobizLogin() {
  const authIdInput = document.getElementById("vobiz-auth-id");
  const authTokenInput = document.getElementById("vobiz-auth-token");
  const authId = authIdInput ? authIdInput.value.trim() : "";
  const authToken = authTokenInput ? authTokenInput.value.trim() : "";

  if (!authId || !authToken) {
    setLoginStatus("Enter both an Auth ID and an Auth Token.");
    return;
  }

  setLoginStatus("Logging in…");
  try {
    const data = await backendJson("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, authId, authToken }),
    });

    sessionToken = data.token;
    sessionStorage.setItem("vobiz_session_token", sessionToken);

    try { await backendJson("/setup", { method: "POST" }); } catch (e) { console.warn("[Vobiz] setup note:", e); }
    renderNumberOptions(data.numbers, data.selected);
    setLoginStatus(`Logged in as ${authId} — calling from ${data.selected}`);
    setDialEnabled(true);
    loadCallHistory();
    initVobizSip();
  } catch (err) {
    setLoginStatus(`Login failed: ${err.message}`);
    setDialEnabled(false);
  }
}

async function vobizSelectNumber(e) {
  const number = e.target.value;
  try {
    await backendJson("/select-number", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number }),
    });
    setLoginStatus(`Caller ID set to ${number}`);
  } catch (err) {
    setLoginStatus(`Could not set caller ID: ${err.message}`);
  }
}

// ─── UI updates ──────────────────────────────────────────────────────────────

function setStatus(text, tone = "pending") {
  const badge = document.getElementById("status") || document.getElementById("vobiz-status-badge");
  const msg = document.getElementById("status-message") || document.getElementById("status-text");

  if (badge) {
    if (text === "Ready" || tone === "ok") {
      badge.textContent = "READY";
      badge.className = "status-badge is-ok registered";
    } else if (tone === "error") {
      badge.textContent = "OFFLINE";
      badge.className = "status-badge is-error unregistered";
    } else {
      badge.textContent = text.toUpperCase();
      badge.className = `status-badge is-${tone}`;
    }
  }

  if (msg) {
    msg.textContent = text;
    if (text === "Ready" || tone === "ok") {
      msg.className = "status-message is-ok";
    } else if (tone === "error") {
      msg.className = "status-message is-error";
    } else if (tone === "busy") {
      msg.className = "status-message is-busy";
    } else {
      msg.className = `status-message is-${tone}`;
    }
  }
}

function setLoginStatus(text) {
  const el = document.getElementById("vobiz-login-status");
  if (el) el.textContent = text;
}

function setDialEnabled(enabled) {
  accountReady = Boolean(enabled);
  updateDialButtonState();
}

function setSipRegistered(registered) {
  sipRegistered = Boolean(registered);
  const badge = document.getElementById("status") || document.getElementById("vobiz-status-badge");
  if (badge) {
    if (registered) {
      badge.textContent = "READY";
      badge.className = "status-badge is-ok registered";
    } else {
      badge.textContent = "OFFLINE";
      badge.className = "status-badge is-error unregistered";
    }
  }
  updateDialButtonState();
}

function updateDialButtonState() {
  const dialBtn = document.getElementById("dialbtn");
  const numSelect = document.getElementById("vobiz-number-select");
  const dialInput = document.getElementById("dialnumber");

  const canDial = accountReady && sipRegistered;
  if (dialBtn) dialBtn.disabled = !canDial;
  if (dialInput) dialInput.disabled = !accountReady;
  if (numSelect) numSelect.disabled = !accountReady;
}

function setHangupVisible(visible) {
  const dialBtn = document.getElementById("dialbtn");
  const hangupBtn = document.getElementById("hangupbtn");
  const numEl = document.getElementById("callnum");
  const timerEl = document.getElementById("call-timer");

  if (visible) {
    if (dialBtn) dialBtn.hidden = true;
    if (hangupBtn) hangupBtn.hidden = false;
    if (timerEl) timerEl.hidden = false;
  } else {
    if (dialBtn) dialBtn.hidden = false;
    if (hangupBtn) hangupBtn.hidden = true;
    if (timerEl) timerEl.hidden = true;
    if (numEl) numEl.hidden = true;
  }
}

function renderNumberOptions(numbers, selected) {
  const select = document.getElementById("vobiz-number-select");
  const label = document.getElementById("vobiz-number-label");
  if (!select) return;
  select.innerHTML = "";
  if (!numbers || !numbers.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No numbers found on this account";
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  numbers.forEach(num => {
    const opt = document.createElement("option");
    opt.value = num;
    opt.textContent = num;
    if (num === selected) opt.selected = true;
    select.appendChild(opt);
  });
  select.disabled = false;
  select.hidden = false;
  if (label) label.hidden = false;
}

// ─── recordings & history ────────────────────────────────────────────────────

async function loadCallHistory() {
  const historyList = document.getElementById("call-history-list");
  if (!historyList) return;

  historyList.innerHTML = `<li class="history-empty">Loading recent recordings…</li>`;
  try {
    const data = await backendJson("/recordings?limit=10");
    const recordings = (data && data.recordings) || [];
    if (!recordings.length) {
      historyList.innerHTML = `<li class="history-empty">No calls recorded yet. Completed calls with audio will appear here automatically.</li>`;
      return;
    }

    historyList.innerHTML = "";
    recordings.forEach(rec => {
      const li = document.createElement("li");
      li.className = "history-item";

      const topRow = document.createElement("div");
      topRow.className = "history-top";

      const timeSpan = document.createElement("span");
      timeSpan.className = "history-time";
      timeSpan.textContent = rec.add_time || "Recent call";

      const durSpan = document.createElement("span");
      durSpan.className = "history-dur";
      durSpan.textContent = formatDuration(Number(rec.rounded_recording_duration || 0));

      topRow.appendChild(timeSpan);
      topRow.appendChild(durSpan);

      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.className = "history-audio";
      audio.src = `${backendUrl}/play-recording?callUuid=${encodeURIComponent(rec.call_uuid)}`;

      li.appendChild(topRow);
      li.appendChild(audio);
      historyList.appendChild(li);
    });
  } catch (err) {
    historyList.innerHTML = `<li class="history-empty">Recordings unavailable (${err.message}). Sign in above to view recordings.</li>`;
  }
}

// ─── inbound setup helper ───────────────────────────────────────────────────

async function setupInboundCalling() {
  const statusEl = document.getElementById("inbound-setup-status");
  if (statusEl) {
    statusEl.textContent = "Configuring inbound webhook…";
    statusEl.hidden = false;
  }
  try {
    const data = await backendJson("/setup-inbound", { method: "POST" });
    if (statusEl) {
      statusEl.textContent = data.message || "Inbound configuration updated successfully.";
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Inbound setup note: ${err.message}`;
    }
  }
}

// ─── SIP WebRTC client ───────────────────────────────────────────────────────

function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;
  const bindTrack = pc => {
    if (!pc) return;
    pc.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[Vobiz] audio autoplay blocked:", err));
    });
  };
  session.on("peerconnection", e => bindTrack(e.peerconnection));
  bindTrack(session.connection);
}

async function initVobizSip() {
  if (vobizUA && vobizUA.isRegistered()) return;

  let agent;
  try {
    const res = await backendFetch(`/agent/${encodeURIComponent(agentId)}`);
    if (!res.ok) {
      // Fallback for session-based /agent
      const resSession = await backendFetch("/agent");
      if (resSession.ok) agent = await resSession.json();
      else {
        setStatus(`Could not load the identity "${agentId}" — check this app's settings.`, "error");
        setSipRegistered(false);
        return;
      }
    } else {
      agent = await res.json();
    }
  } catch (err) {
    console.error("[Vobiz] Could not reach calling backend:", err);
    setStatus("Cannot reach the calling backend — check the Backend URL in this app's settings.", "error");
    setSipRegistered(false);
    return;
  }

  agentIdentity = agent;
  startSipUA(agent.sipUser, agent.sipPassword, agent.displayName);
}

// ─── Incoming Call Controls & Ringtone ───────────────────────────────────────

let incomingPending = false;
let ringCtx = null;
let ringTimer = null;

function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ringCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.95);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) {
    console.warn("[Vobiz] ringtone note:", err);
  }
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringCtx) {
    try { ringCtx.close(); } catch { /* ignore */ }
    ringCtx = null;
  }
}

function showIncoming(caller) {
  const fromEl = document.getElementById("incoming-from");
  if (fromEl) fromEl.textContent = caller || "Unknown";
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = false;
}

function endIncoming(status = "Ready") {
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;
  setHangupVisible(false);
  currentRTCSession = null;
  if (status) setStatus(status, "ok");
}

async function acceptCall() {
  if (!currentRTCSession) return;
  incomingPending = false;
  stopRingtone();
  const banner = document.getElementById("incoming");
  if (banner) banner.hidden = true;

  try {
    attachRemoteAudio(currentRTCSession);
    currentRTCSession.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    setHangupVisible(true);
    setStatus("On a call", "busy");
  } catch (err) {
    console.error("[Vobiz] Could not answer incoming leg:", err);
    try { currentRTCSession.terminate(); } catch { /* ignore */ }
    endIncoming();
  }
}

function declineCall() {
  if (!currentRTCSession) return;
  incomingPending = false;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] decline failed:", err);
  }
  endIncoming();
}

/**
 * Bring up the SIP stack for one identity.
 *
 * Shared by both ways in: the account sign-in above, which asks the backend
 * which identity this installation is, and SIP-direct sign-in, where the agent
 * types the endpoint's own credentials and the backend is never involved.
 */
function startSipUA(sipUser, sipPassword, displayName) {
  setStatus(`Connecting as ${displayName || sipUser}…`, "pending");

  if (vobizUA) {
    const previous = vobizUA;
    vobizUA = null;
    try { previous.removeAllListeners(); } catch { /* ignore */ }
    try { previous.stop(); } catch { /* ignore */ }
  }

  if (typeof JsSIP === "undefined") {
    console.error("[Vobiz] JsSIP is undefined — assets/lib/jssip.min.js missing or blocked.");
    setStatus("SIP library failed to load.", "error");
    setSipRegistered(false);
    return;
  }

  try {
    const cleanUri = sipUser.startsWith("sip:") ? sipUser : `sip:${sipUser}`;
    const vobizSocket = new JsSIP.WebSocketInterface(registrarUrl);
    vobizUA = new JsSIP.UA({
      sockets: [vobizSocket],
      uri: cleanUri,
      password: sipPassword,
      display_name: displayName || sipUser,
      register: true,
      user_agent: "VobizZendeskCalling/2.0.0",
      session_timers: false,
    });

    vobizUA.on("registered", () => {
      setStatus("Ready", "ok");
      setSipRegistered(true);
    });
    vobizUA.on("registrationFailed", e => {
      setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`, "error");
      setSipRegistered(false);
    });
    vobizUA.on("unregistered", () => {
      setStatus("Not registered — reconnecting…", "pending");
      setSipRegistered(false);
    });
    vobizUA.on("disconnected", () => {
      setStatus("Disconnected from registrar", "error");
      setSipRegistered(false);
    });

    // Handle incoming calls (inbound leg)
    vobizUA.on("newRTCSession", data => {
      if (data.originator !== "remote") return;

      const remoteCaller = (data.session && data.session.remote_identity && data.session.remote_identity.uri && data.session.remote_identity.uri.user) || "Unknown caller";
      callDirection = "Inbound";
      currentRTCSession = data.session;
      incomingPending = true;

      // Pop open the Zendesk top bar softphone pane and send a native desktop toast notification
      if (client) {
        try { client.invoke("popover", "show"); } catch (e) { /* ignore */ }
        try { client.invoke("notify", `📞 Incoming call from ${remoteCaller}`, "notice"); } catch (e) { /* ignore */ }
      }

      setStatus(`Incoming call from ${remoteCaller}`, "busy");
      showIncoming(remoteCaller);
      startRingtone();

      currentRTCSession.on("confirmed", () => {
        startTimer();
        setStatus("On a call", "busy");
        const numEl = document.getElementById("callnum");
        if (numEl) {
          numEl.textContent = `On a call with ${remoteCaller}`;
          numEl.hidden = false;
        }
      });

      const onCallDone = () => {
        stopTimer();
        endIncoming("Ready");
        const numEl = document.getElementById("callnum");
        if (numEl) {
          numEl.textContent = "Call ended";
          setTimeout(() => { numEl.hidden = true; }, 4000);
        }
        setHangupVisible(false);
        autoLogCallToZendesk();
        setTimeout(loadCallHistory, 5000);
      };

      currentRTCSession.on("ended", onCallDone);
      currentRTCSession.on("failed", onCallDone);
    });

    vobizUA.start();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("No microphone access in this frame — calls cannot connect.", "error");
    }
  } catch (err) {
    console.error("[Vobiz] Failed to initialise SIP UA:", err);
    setStatus("Failed to connect SIP transport.", "error");
    setSipRegistered(false);
  }
}

function callHeaders() {
  const headers = [];
  if (authMode === "sip") {
    const callerId = sipDirectCallerId().replace(/[^\d+]/g, "");
    if (callerId) headers.push(`X-VH-Caller-ID: ${callerId}`);
  }
  return headers;
}

// ─── place call ──────────────────────────────────────────────────────────────

async function onTriggerDialer(event) {
  if (client) {
    try { await client.invoke("popout"); } catch { /* non-fatal */ }
  }
  const data = (event && event.helper && event.helper.getData && event.helper.getData()) || (event && event.data) || event || {};
  const number = data.number || data.phoneNumber || (typeof data === "string" ? data : "");
  if (data.ticketId) activeTicketId = data.ticketId;
  if (number && typeof number === "string") {
    const input = document.getElementById("dialnumber");
    if (input) input.value = number;
    await placeCall(number);
  }
}

function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  placeCall(number);
}

async function placeCall(number) {
  if (!number) return;

  const numEl = document.getElementById("callnum");
  if (numEl) {
    numEl.textContent = `Calling ${number}…`;
    numEl.hidden = false;
  }

  if (!vobizUA || !sipRegistered) {
    const message = "Not registered yet — wait for the badge to go green.";
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
    return;
  }

  if (currentRTCSession) {
    if (numEl) numEl.textContent = "Already on an active call.";
    return;
  }

  callDirection = "Outbound";
  lastDialedNumber = number;
  lastCallRecord = null;
  searchZendeskUser(number);
  activeTicketId = await findCurrentTicketId();

  const cleanNumber = String(number).replace(/[^\d+]/g, "");
  const target = `sip:${cleanNumber}@${REGISTRAR_HOST}`;

  try {
    const session = vobizUA.call(target, {
      extraHeaders: callHeaders(),
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });

    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);

    session.on("progress", () => {
      if (numEl) numEl.textContent = `Ringing ${number}…`;
      setStatus("Ringing", "busy");
    });

    session.on("confirmed", () => {
      startTimer();
      if (numEl) numEl.textContent = `On a call with ${number}`;
      setStatus("On a call", "busy");
    });

    session.on("failed", e => {
      stopTimer();
      const cause = (e && e.cause) || "unknown";
      if (numEl) numEl.textContent = `Call failed — ${cause}`;
      setStatus("Ready", "ok");
      currentRTCSession = null;
      setHangupVisible(false);
    });

    session.on("ended", () => {
      stopTimer();
      if (numEl) {
        numEl.textContent = "Call ended";
        setTimeout(() => { numEl.hidden = true; }, 4000);
      }
      setStatus("Ready", "ok");
      currentRTCSession = null;
      setHangupVisible(false);

      // Log call to ticket and refresh recordings
      autoLogCallToZendesk();
      setTimeout(loadCallHistory, 5000);
    });
  } catch (err) {
    console.error("[Vobiz] Could not start the call:", err);
    const message = err && err.name === "NotAllowedError"
      ? "Microphone permission was refused for this frame"
      : `Could not start the call — ${err.message}`;
    if (numEl) numEl.textContent = message;
    setLoginStatus(message);
    setHangupVisible(false);
  }
}

function hangUp() {
  if (!currentRTCSession) return;
  try {
    currentRTCSession.terminate();
  } catch (err) {
    console.warn("[Vobiz] hangup failed:", err);
  }
}

// ─── Zendesk ticket write-back ───────────────────────────────────────────────

function searchZendeskUser(phoneNumber) {
  resolvedUser = null;
  if (!client) return;
  const clean = String(phoneNumber).replace(/[^\d+]/g, "");
  if (!clean) return;

  client.request(`/api/v2/search.json?query=${encodeURIComponent(`type:user phone:${clean}`)}`)
    .then(data => {
      if (data && data.results && data.results.length) {
        resolvedUser = data.results[0];
      }
    })
    .catch(err => console.warn("[Vobiz] Zendesk user search note:", err.message));
}

async function findCurrentTicketId() {
  if (!client) return null;
  try {
    const { instances } = await client.get("instances");
    for (const guid of Object.keys(instances)) {
      if (instances[guid].location !== "ticket_sidebar") continue;
      const data = await client.instance(guid).get("ticket.id");
      if (data && data["ticket.id"]) return data["ticket.id"];
    }
  } catch (err) {
    console.warn("[Vobiz] Could not resolve active ticket:", err);
  }
  return null;
}

async function autoLogCallToZendesk() {
  if (!client && !backendUrl) return;

  // Short delay so backend call ledger captures the CallUUID
  await new Promise(r => setTimeout(r, 1200));

  let recordingUrl = "";
  try {
    const recData = await backendJson(`/call-record?to=${encodeURIComponent(lastDialedNumber)}`);
    if (recData && recData.found && recData.callUuid) {
      recordingUrl = recData.recordingUrl || `${backendUrl}/play-recording?callUuid=${recData.callUuid}`;
    }
  } catch (e) {
    console.warn("[Vobiz] call-record fetch note:", e.message);
  }

  const durationText = formatDuration(callDurationSeconds);
  const customerName = resolvedUser ? resolvedUser.name : "Customer";
  const body = `[Vobiz Call Log]\n` +
    `Date: ${new Date().toLocaleString()}\n` +
    `Direction: ${callDirection}\n` +
    `Phone: ${lastDialedNumber}\n` +
    `Duration: ${durationText}\n` +
    (recordingUrl ? `Recording: 🎧 [Listen to Call Recording](${recordingUrl})\n` : '') +
    `Status: Completed`;

  try {
    // Attempt backend sync
    await backendJson("/sync-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: zendeskSubdomain,
        ticketId: activeTicketId,
        toNumber: lastDialedNumber,
        duration: callDurationSeconds,
        callDirection,
        notes: `Call with ${customerName} (${lastDialedNumber})`,
        requesterId: resolvedUser ? resolvedUser.id : null,
      }),
    });
    if (client) client.invoke("notify", "Call logged to Zendesk.");
    return;
  } catch (err) {
    console.warn("[Vobiz] Backend sync failed, attempting direct ZAF log:", err.message);
  }

  // ZAF fallback
  if (client) {
    try {
      if (activeTicketId) {
        await client.request({
          url: `/api/v2/tickets/${activeTicketId}.json`,
          type: "PUT",
          contentType: "application/json",
          data: JSON.stringify({ ticket: { comment: { body, public: false } } }),
        });
        client.invoke("notify", `Call logged to ticket #${activeTicketId}.`);
      } else {
        const res = await client.request({
          url: "/api/v2/tickets.json",
          type: "POST",
          contentType: "application/json",
          data: JSON.stringify({
            ticket: {
              subject: `Call with ${customerName} (${lastDialedNumber})`,
              comment: { body, public: false },
              type: "task",
              status: "solved",
              requester_id: resolvedUser ? resolvedUser.id : null,
            },
          }),
        });
        if (res && res.ticket) client.invoke("notify", `Call logged as ticket #${res.ticket.id}.`);
      }
    } catch (zafErr) {
      console.warn("[Vobiz] Direct ZAF logging note:", zafErr.message);
    }
  }
}

// ─── timer helper ────────────────────────────────────────────────────────────

function startTimer() {
  callDurationSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    callDurationSeconds++;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
