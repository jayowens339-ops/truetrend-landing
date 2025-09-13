// Vercel serverless function: one file does it all.
// 1) Verifies Stripe Checkout session_id server-side (no SDK needed)
// 2) Renders the Thank-You page
// 3) Auto-starts your ZIP download
// 4) ?diag=1 shows quick diagnostics (no payment required)
//
// PUT THIS FILE AT:   api/thankyou.js
//
// REQUIRED ENV VARS (Vercel -> Project -> Settings -> Environment Variables):
//   STRIPE_SECRET_KEY      = sk_live_xxx   (or test key while testing)
//   DIRECT_DOWNLOAD_URL    = https://www.trytruetrend.com/releases/TrueTrend_Universal_Chrome_Extension_v4.3.3.5.zip
//
// STRIPE SUCCESS URL (in your Checkout session / Payment Link):
//   https://www.trytruetrend.com/api/thankyou?session_id={CHECKOUT_SESSION_ID}

const PAGE = ({ ok, msg = "", downloadUrl = "", product = "TrueTrend" }) => `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${ok ? "Thanks!" : "We couldn’t verify your payment"}</title>
  <style>
    :root{--bg:#0b0f1a;--panel:#111526;--text:#e6eaff;--muted:#a2a9c9;--good:#b8ffbf;--bad:#ffb8c1;--brand:#0c1324;}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{max-width:760px;margin:7vh auto;padding:28px;background:var(--panel);border:1px solid #232846;border-radius:16px}
    h1{margin:0 0 10px}
    p{margin:10px 0}
    .good{color:var(--good)} .bad{color:var(--bad)}
    .row{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
    a.btn{display:inline-block;padding:12px 18px;border-radius:10px;color:#fff;background:#2a3570;text-decoration:none;font-weight:700}
    a.btn.primary{background:var(--brand)}
    code{background:#0e1220;border:1px solid #2b3152;border-radius:6px;padding:2px 6px}
    .muted{color:var(--muted);font-size:13px}
    .box{background:#0e1220;border:1px solid #2b3152;border-radius:8px;padding:10px 12px;overflow:auto}
  </style>
</head><body>
  <div class="wrap">
    ${ok ? `
      <h1 class="good">✅ Thanks for subscribing to ${product}!</h1>
      <p>Your payment session was verified. Your download should start automatically.</p>
      <div class="row">
        <a class="btn primary" id="dl" href="${downloadUrl}">⬇️ Download ${product}</a>
        <a class="btn" href="${downloadUrl}" download>Save file</a>
      </div>
      <p class="muted">Didn’t start? Click the button above or check your email for the link.</p>
      <script>
        setTimeout(()=>{ try{ location.href=${JSON.stringify(downloadUrl)} }catch(e){} }, 800);
      </script>
    ` : `
      <h1 class="bad">❌ We couldn’t verify your payment</h1>
      <p>${msg}</p>
      <p class="muted">If you were charged, share your <code>session_id</code> with support and we’ll help.</p>
    `}
  </div>
</body></html>`;

async function getStripeSession(secretKey, sessionId) {
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => `${r.status}`);
    return { ok: false, reason: `Stripe ${r.status}: ${t.slice(0,240)}` };
  }
  return { ok: true, data: await r.json() };
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session_id") || "";
  const diag = url.searchParams.has("diag");

  const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY || "";
  const DIRECT_DOWNLOAD_URL = process.env.DIRECT_DOWNLOAD_URL || "";
  const PRODUCT_NAME        = process.env.PRODUCT_NAME || "TrueTrend";

  // Diagnostics (no payment required)
  if (diag) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({
      ok: true,
      hasStripeKey: !!STRIPE_SECRET_KEY,
      hasDownloadUrl: !!DIRECT_DOWNLOAD_URL,
      note: "Add ?session_id=cs_... to test a real session."
    }, null, 2));
    return;
  }

  if (!STRIPE_SECRET_KEY) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(PAGE({ ok:false, msg:"Missing STRIPE_SECRET_KEY (set it in Vercel env variables)." }));
    return;
  }
  if (!sessionId) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(PAGE({ ok:false, msg:"Missing ?session_id in the URL." }));
    return;
  }

  const out = await getStripeSession(STRIPE_SECRET_KEY, sessionId);
  if (!out.ok) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(PAGE({ ok:false, msg: out.reason }));
    return;
  }

  const s = out.data || {};
  const isComplete = s.status === "complete" || s.payment_status === "paid";
  if (!isComplete) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(PAGE({
      ok:false,
      msg:`Session not complete yet. status=${s.status || "?"}, payment_status=${s.payment_status || "?""}`
    }));
    return;
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(PAGE({
    ok:true,
    downloadUrl: DIRECT_DOWNLOAD_URL,
    product: PRODUCT_NAME
  }));
}
