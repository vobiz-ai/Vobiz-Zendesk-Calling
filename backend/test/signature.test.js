const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { makeVerifier, baseUrlFor, sign, checkSignature } = require("../vobiz-signature");

const DUMMY_TOKEN = "test_auth_token_secret_1234567890";
const PUBLIC_BASE = "https://example.ngrok.app";

test("vobiz-signature unit tests", async (t) => {
  await t.test("checkSignature returns absent when no signature headers are present", () => {
    const res = checkSignature({}, [DUMMY_TOKEN], "https://example.ngrok.app/answer");
    assert.equal(res, "absent");
  });

  await t.test("checkSignature validates V3 signature correctly", () => {
    const url = "https://example.ngrok.app/answer";
    const nonce = "12345678";
    const signature = sign(DUMMY_TOKEN, `${url}.${nonce}`);

    const headers = {
      "x-vobiz-signature-v3": signature,
      "x-vobiz-signature-v3-nonce": nonce,
    };
    const res = checkSignature(headers, [DUMMY_TOKEN], url);
    assert.equal(res, "valid");
  });

  await t.test("checkSignature validates V2 signature correctly", () => {
    const url = "https://example.ngrok.app/answer";
    const nonce = "87654321";
    const signature = sign(DUMMY_TOKEN, `${url}${nonce}`);

    const headers = {
      "x-vobiz-signature-v2": signature,
      "x-vobiz-signature-v2-nonce": nonce,
    };
    const res = checkSignature(headers, [DUMMY_TOKEN], url);
    assert.equal(res, "valid");
  });

  await t.test("checkSignature rejects invalid signature", () => {
    const url = "https://example.ngrok.app/answer";
    const headers = {
      "x-vobiz-signature-v3": "invalid_signature",
      "x-vobiz-signature-v3-nonce": "12345678",
    };
    const res = checkSignature(headers, [DUMMY_TOKEN], url);
    assert.equal(res, "invalid");
  });

  await t.test("makeVerifier with require mode rejects unsigned callback", () => {
    const verifier = makeVerifier({ mode: "require", publicBaseUrl: () => PUBLIC_BASE });
    const allowed = verifier({ headers: {} }, "/answer", [DUMMY_TOKEN]);
    assert.equal(allowed, false);
  });

  await t.test("makeVerifier with require mode accepts valid V3 signature", () => {
    const verifier = makeVerifier({ mode: "require", publicBaseUrl: () => PUBLIC_BASE });
    const url = `${PUBLIC_BASE}/answer`;
    const nonce = "nonce123";
    const signature = sign(DUMMY_TOKEN, `${url}.${nonce}`);
    const req = {
      headers: {
        "x-vobiz-signature-v3": signature,
        "x-vobiz-signature-v3-nonce": nonce,
      },
    };
    const allowed = verifier(req, "/answer", [DUMMY_TOKEN]);
    assert.equal(allowed, true);
  });

  await t.test("makeVerifier with off mode allows unsigned callback", () => {
    const verifier = makeVerifier({ mode: "off", publicBaseUrl: () => PUBLIC_BASE });
    const allowed = verifier({ headers: {} }, "/answer", [DUMMY_TOKEN]);
    assert.equal(allowed, true);
  });

  await t.test("makeVerifier with verify mode allows unsigned but rejects invalid", () => {
    const verifier = makeVerifier({ mode: "verify", publicBaseUrl: () => PUBLIC_BASE });
    assert.equal(verifier({ headers: {} }, "/answer", [DUMMY_TOKEN]), true);
    assert.equal(
      verifier(
        { headers: { "x-vobiz-signature-v3": "bad", "x-vobiz-signature-v3-nonce": "123" } },
        "/answer",
        [DUMMY_TOKEN]
      ),
      false
    );
  });
});

test("Express webhook endpoints signature integration tests", async (t) => {
  process.env.VOBIZ_AUTH_TOKEN = DUMMY_TOKEN;
  process.env.PUBLIC_BASE = PUBLIC_BASE;
  process.env.VOBIZ_WEBHOOK_SIGNATURES = "require";

  // Re-require server to pick up environment variables
  const { app } = require("../server");
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const localUrl = `http://localhost:${port}`;

  t.after(() => {
    server.close();
  });

  await t.test("POST /answer without signature returns 403 Forbidden by default", async () => {
    const res = await fetch(`${localUrl}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallUUID=123&From=%2B919999999999&To=%2B918888888888",
    });
    assert.equal(res.status, 403);
    const body = await res.text();
    assert.match(body, /Forbidden/i);
  });

  await t.test("POST /dial-status without signature returns 403 Forbidden", async () => {
    const res = await fetch(`${localUrl}/dial-status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallUUID=123&DialStatus=completed",
    });
    assert.equal(res.status, 403);
  });

  await t.test("POST /recording-ready without signature returns 403 Forbidden", async () => {
    const res = await fetch(`${localUrl}/recording-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallUUID=123&RecordingID=rec123",
    });
    assert.equal(res.status, 403);
  });

  await t.test("POST /answer with valid V3 signature is accepted", async () => {
    const nonce = "testnonce999";
    const canonicalUrl = `${PUBLIC_BASE}/answer`;
    const signature = sign(DUMMY_TOKEN, `${canonicalUrl}.${nonce}`);

    const res = await fetch(`${localUrl}/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Vobiz-Signature-V3": signature,
        "X-Vobiz-Signature-V3-Nonce": nonce,
      },
      body: "CallUUID=test-uuid-valid&From=%2B919999999999&To=%2B918888888888&Event=Hangup",
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<Response>/);
  });
});
