const crypto = require("node:crypto");

/**
 * Vobiz callback signatures (https://www.vobiz.ai/docs/concepts/validating-callbacks).
 *
 *   V3 = base64(HMAC-SHA256(key = Auth Token, msg = baseURL + "." + nonce))
 *   V2 = base64(HMAC-SHA256(key = Auth Token, msg = baseURL + nonce))
 *
 * baseURL is the callback URL with the query string removed. The signature
 * covers the URL and the nonce, never the body — voice webhooks are
 * form-encoded, so a body-hashing scheme never verifies. Behind a tunnel the
 * URL Vobiz called is the public one, so it is rebuilt from PUBLIC_BASE.
 */
function baseUrlFor(publicBaseUrl, pathname) {
  return `${String(publicBaseUrl || "").replace(/\/+$/, "")}${pathname}`;
}

function sign(authToken, msg) {
  return crypto.createHmac("sha256", authToken).update(msg).digest("base64");
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Returns "valid", "invalid" or "absent".
 */
function checkSignature(headers, authTokens, url) {
  const h = (name) => {
    const val = headers[name.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  };
  const v3 = h("x-vobiz-signature-v3");
  const v3n = h("x-vobiz-signature-v3-nonce");
  const v2 = h("x-vobiz-signature-v2");
  const v2n = h("x-vobiz-signature-v2-nonce");
  if (!v3 && !v2) return "absent";
  const tokens = (Array.isArray(authTokens) ? authTokens : [authTokens]).filter(Boolean);
  for (const authToken of tokens) {
    if (v3 && v3n && equal(v3, sign(authToken, `${url}.${v3n}`))) return "valid";
    if (v2 && v2n && equal(v2, sign(authToken, `${url}${v2n}`))) return "valid";
  }
  return "invalid";
}

/**
 * VOBIZ_WEBHOOK_SIGNATURES:
 *   require — default. Reject any callback without a valid signature (HTTP 403).
 *   verify  — reject a callback whose signature is present but wrong; let an unsigned
 *             one through with a warning.
 *   off     — do not check.
 */
function makeVerifier({ mode, publicBaseUrl }) {
  const m = String(mode || process.env.VOBIZ_WEBHOOK_SIGNATURES || "require").toLowerCase();
  let warnedAbsent = false;
  let loggedValid = false;

  return function verify(req, pathname, authTokens, opts = {}) {
    if (m === "off") return true;
    const base = typeof publicBaseUrl === "function" ? publicBaseUrl() : publicBaseUrl;
    const url = baseUrlFor(base, pathname);
    let result = checkSignature(req.headers || {}, authTokens, url);

    if (result === "invalid" && opts.noKey) {
      console.warn(`[signature] cannot check the signature on ${pathname}: no Auth Token held for account`);
      result = "absent";
    }

    if (result === "valid") {
      if (!loggedValid) {
        console.log(`[signature] valid Vobiz signature on ${pathname}`);
        loggedValid = true;
      }
      return true;
    }

    if (result === "invalid") {
      console.error(`[signature] INVALID Vobiz signature on ${pathname} (checked against ${url}) — rejected.`);
      return false;
    }

    if (m === "require") {
      console.error(`[signature] unsigned callback on ${pathname} rejected (VOBIZ_WEBHOOK_SIGNATURES=require)`);
      return false;
    }

    if (!warnedAbsent) {
      console.warn(`[signature] unsigned callback on ${pathname} accepted. Set VOBIZ_WEBHOOK_SIGNATURES=require once your callbacks arrive signed.`);
      warnedAbsent = true;
    }
    return true;
  };
}

module.exports = { checkSignature, makeVerifier, baseUrlFor, sign };
