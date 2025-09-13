// api/thankyou.js  — one file, CommonJS, no extra config

const page = ({ ok, msg = "", url = "", name = "TrueTrend" }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${ok ? "Thanks!" : "Payment not verified"}</title>
<style>
  :root{--bg:#0b0f1a;--panel:#111526;--text:#e6eaff;--muted:#a2a9c9;--ok:#b8ffbf;--bad:#ffb8c1;--brand:#0c1324}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,Segoe UI,Roboto,Arial}
  .wrap{max-width:760px;margin:7vh auto;padding:28px;background:var(--panel);border:1px solid #232846;border-radius:16px}
  h1{margin:0 0 10px}.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--muted);font-size:13px}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
  a.btn{display:inline-block;padding:12px 18px;border-radius:10px;color:#fff;background:var(--brand);text-decoration:none;font-weight:700}
  code{background:#0e1220;border:1px solid #2b3152;border-radius:6px;padding:2px 6px}
</style></head><body>
<div class="wrap">
  ${ok ? `
    <h1 class="ok">✅ Thanks for subscribing to ${name}!</h1>
    <p>Your download should start automatically.</p>
    <div class="row"><a class="btn" href="${url}" id="dl">⬇️ Download ${name}</a></div>
    <p class="muted">Didn’t start? Click the button above.</p>
    <script>setTimeout(()=>{location.href=${JSON.stringify(url)}},800)</script>
  ` : `
    <h1 class="bad">❌ We couldn’t verify your payment</h1>
    <p>${msg}</p>
  `}
</div></body></html>`;

// Call Stripe without any SDK
async function fetchStripeSession(secretKey, sessionId) {
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  if (!r.ok) {
    const t = await r.text().catch(()=>String(r.status));
    return { ok:false, reason:`Stripe ${r.status}: ${t.slice(0,240)}` };
  }
  return { ok:true, data: await r.json() };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session_id") || "";
  const diag      = url.searchParams.has("diag");

  const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY || "";
  const DIRECT_DOWNLOAD_URL = process.env.DIRECT_DOWNLOAD_URL || "";
  const PRODUCT_NAME        = process.env.PRODUCT_NAME || "TrueTrend";

  // quick diagnostics (no payment needed)
  if (diag) {
    res.setHeader("content-type","application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({
      ok:true,
      hasStripeKey: !!STRIPE_SECRET_KEY,
      hasDownloadUrl: !!DIRECT_DOWNLOAD_URL
    }, null, 2));
    return;
  }

  if (!STRIPE_SECRET_KEY) {
    res.setHeader("content-type","text/html; charset=utf-8");
    res.status(200).send(page({ ok:false, msg:"Missing STRIPE_SECRET_KEY in Vercel env." }));
    return;
  }
  if (!sessionId) {
    res.setHeader("content-type","text/html; charset=utf-8");
    res.status(200).send(page({ ok:false, msg:"Missing ?session_id in URL." }));
    return;
  }

  const out = await fetchStripeSession(STRIPE_SECRET_KEY, sessionId);
  if (!out.ok) {
    res.setHeader("content-type","text/html; charset=utf-8");
    res.status(200).send(page({ ok:false, msg: out.reason }));
    return;
  }

  const s = out.data || {};
  const paid = s.status === "complete" || s.payment_status === "paid";

  res.setHeader("content-type","text/html; charset=utf-8");
  if (!paid) {
    res.status(200).send(page({ ok:false, msg:`Session not complete yet (status=${s.status || "?"}, payment_status=${s.payment_status || "?"}).` }));
  } else {
    res.status(200).send(page({ ok:true, url: DIRECT_DOWNLOAD_URL, name: PRODUCT_NAME }));
  }
};
