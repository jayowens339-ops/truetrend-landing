// One-file Thank-You + Download page for Vercel
// Redirect Stripe “After payment” to:
//   https://YOURDOMAIN.com/api/installer?session_id={CHECKOUT_SESSION_ID}
//
// Env vars required in Vercel:
//   STRIPE_SECRET_KEY      = sk_live_... (or test key while testing)
//   DIRECT_DOWNLOAD_URL    = https://www.trytruetrend.com/releases/TrueTrend_Universal_Chrome_Extension_v4.3.3.5.zip
//
// Optional env vars:
//   PRODUCT_NAME           = "TrueTrend"
//   BRAND_COLOR            = "#0c1324"

const HTML = ({
  ok,
  reason = "",
  downloadUrl = "",
  productName = "TrueTrend",
  color = "#0c1324",
  sessionId = "",
}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${ok ? "Thanks for subscribing!" : "We couldn't verify your payment"}</title>
  <style>
    :root { --c:${color}; }
    body { font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; padding:0; background:#0b0b10; color:#fff; }
    .wrap { max-width: 760px; margin: 6vh auto 10vh; padding: 28px; background: #10121b; border: 1px solid #26293a; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.3);}
    h1 { margin: 0 0 10px; font-size: 28px; }
    h2 { margin: 24px 0 10px; font-size: 18px; color:#a6accd; font-weight:600;}
    p  { line-height: 1.55; color:#cfd5ff; }
    .ok { color:#b8ffbf; }
    .bad{ color:#ffb8c1; }
    .row{ display:flex; gap:14px; flex-wrap:wrap; margin:18px 0; }
    a.btn{ display:inline-block; background:var(--c); color:#fff; text-decoration:none; padding:12px 18px; border-radius:12px; font-weight:700; }
    a.ghost{ background:transparent; border:1px solid #3a3f5e; }
    code,kbd{ background:#0f1220; border:1px solid #2a2e49; padding:2px 6px; border-radius:6px; color:#e6eaff; }
    .muted{ color:#9aa0bd; font-size:13px; }
    .box { background:#0f1220; border:1px solid #2a2e49; padding:12px 14px; border-radius:8px; overflow:auto; }
  </style>
</head>
<body>
  <div class="wrap">
    ${ok ? `
      <h1 class="ok">✅ Thanks for subscribing to ${productName}!</h1>
      <p>Your payment session was verified. Your download should start automatically.</p>
      <div class="row">
        <a class="btn" id="dl" href="${downloadUrl}">⬇️ Download ${productName}</a>
        <a class="btn ghost" href="${downloadUrl}" download>Save file</a>
      </div>
      <p class="muted">Didn’t start? Click <a href="${downloadUrl}">here</a> or check your email for the download link.</p>
    ` : `
      <h1 class="bad">❌ We couldn't verify your payment</h1>
      <p>Session check failed. Reason:</p>
      <div class="box"><code>${reason.replace(/</g,"&lt;")}</code></div>
      <h2>What to do</h2>
      <p>If you were just charged and still see this, send us your <kbd>session_id</kbd> below so we can help:</p>
      <div class="box"><code>${sessionId || "(no session provided)"}</code></div>
    `}
    <h2>Need help?</h2>
    <p class="muted">You can always retry the payment redirect or contact support with your <kbd>session_id</kbd>.</p>
  </div>

  ${ok && downloadUrl ? `
  <script>
    // Attempt auto-download and also keep a visible button
    (function(){
      const url = ${JSON.stringify(downloadUrl)};
      setTimeout(()=>{ try { window.location.href = url; } catch(e){} }, 800);
    })();
  </script>` : ``}
</body>
</html>`;

const text = (status, msg) => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: msg + "\n",
});

// Use native fetch to avoid installing stripe library (true “one file”)
async function fetchStripeSession(secretKey, sessionId) {
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!r.ok) {
    const errText = await r.text().catch(()=>String(r.status));
    const reason = `Stripe API ${r.status}. ${errText.slice(0,240)}`;
    return { ok:false, reason };
  }
  const data = await r.json();
  return { ok:true, data };
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session_id") || "";
  const diag      = url.searchParams.has("diag");

  const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY || "";
  const DIRECT_DOWNLOAD_URL = process.env.DIRECT_DOWNLOAD_URL || "";
  const PRODUCT_NAME        = process.env.PRODUCT_NAME || "TrueTrend";
  const BRAND_COLOR         = process.env.BRAND_COLOR || "#0c1324";

  // Diagnostics endpoint to help you confirm env vars without paying
  if (diag) {
    const body = {
      ok: true,
      hasStripeKey: !!STRIPE_SECRET_KEY,
      usingDirect:  !!DIRECT_DOWNLOAD_URL,
      product: PRODUCT_NAME,
      note: "Call this with ?session_id=cs_... to test live verification.",
    };
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(body, null, 2));
    return;
  }

  if (!STRIPE_SECRET_KEY) {
    res.status(200).send(HTML({ ok:false, reason:"Missing STRIPE_SECRET_KEY", productName:PRODUCT_NAME, color:BRAND_COLOR, sessionId }));
    return;
  }

  if (!sessionId) {
    res.status(200).send(HTML({ ok:false, reason:"Missing session_id in querystring", productName:PRODUCT_NAME, color:BRAND_COLOR }));
    return;
  }

  // Verify the Checkout Session with Stripe
  const out = await fetchStripeSession(STRIPE_SECRET_KEY, sessionId);
  if (!out.ok) {
    res.status(200).send(HTML({ ok:false, reason: out.reason || "Stripe verification failed", productName:PRODUCT_NAME, color:BRAND_COLOR, sessionId }));
    return;
  }

  const s = out.data || {};
  // Consider a session valid if it completed successfully (works for one-time or subscription with trial)
  const valid = s.status === "complete" || s.payment_status === "paid";

  if (!valid) {
    res.status(200).send(HTML({
      ok:false,
      reason:`Session not complete. status=${s.status || "?"}, payment_status=${s.payment_status || "?"}`,
      productName:PRODUCT_NAME, color:BRAND_COLOR, sessionId
    }));
    return;
  }

  // Success — render Thank-You with download link
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(HTML({
    ok:true,
    downloadUrl: DIRECT_DOWNLOAD_URL,
    productName: PRODUCT_NAME,
    color: BRAND_COLOR,
    sessionId
  }));
}
