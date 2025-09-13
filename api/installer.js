// /api/installer.js
// One-file Thank-You + Download page with friendly diagnostics.
// Redirect Stripe "After payment" to:
//   https://www.trytruetrend.com/api/installer?session_id={CHECKOUT_SESSION_ID}

import Stripe from "stripe";

// ---- CONFIG FALLBACKS -------------------------------------------------------
const USE_DIRECT = !!process.env.DIRECT_DOWNLOAD_URL; // easiest way to start
const HAS_S3 =
  !!process.env.AWS_BUCKET &&
  !!process.env.AWS_REGION &&
  !!process.env.AWS_ACCESS_KEY_ID &&
  !!process.env.AWS_SECRET_ACCESS_KEY;

let s3 = null, getSignedUrl = null;
if (HAS_S3) {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const presigner = await import("@aws-sdk/s3-request-presigner");
  s3 = {
    client: new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    }),
    cmd: GetObjectCommand,
    presign: presigner.getSignedUrl
  };
}

const stripeKey = process.env.STRIPE_SECRET_KEY; // must be sk_live_... for cs_live_ sessions
const stripe = new Stripe(stripeKey || "", { apiVersion: "2024-06-20" });

// ---- UTIL -------------------------------------------------------------------
function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function diagBlock(rows) {
  return `
    <div style="margin-top:12px;padding:12px;border-radius:10px;background:#0e172a;border:1px solid #233145;color:#dbeafe;font:14px system-ui">
      <b>Diag:</b>
      <ul style="margin:8px 0 0 18px;line-height:1.5">
        ${rows.map(r=>`<li>${escapeHtml(r)}</li>`).join("")}
      </ul>
    </div>
  `;
}

// ---- HANDLER ----------------------------------------------------------------
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const session_id = url.searchParams.get("session_id");

  // Quick ping to verify deployment
  if (url.searchParams.get("diag") === "1") {
    return sendHtml(res, `
      <pre>${escapeHtml(JSON.stringify({
        ok:true,
        hasStripeKey: !!stripeKey,
        usingDirect: USE_DIRECT,
        hasS3: HAS_S3,
        bucket: process.env.AWS_BUCKET || null
      }, null, 2))}</pre>
    `);
  }

  if (!session_id) {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  // 1) Verify Stripe Session
  let session;
  try {
    if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY");
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch (err) {
    const e = String(err?.message || err);
    const tip = session_id.startsWith("cs_live_") && (stripeKey || "").startsWith("sk_test_")
      ? "You are using a TEST key with a LIVE session. Set STRIPE_SECRET_KEY to your sk_live_ key."
      : "Check STRIPE_SECRET_KEY and that this project has stripe installed in package.json.";
    return sendHtml(res, errorPage("Couldn’t verify your payment session.", [
      `Session: ${session_id}`,
      `Error: ${e}`,
      tip
    ]), 500);
  }

  const name  = session.customer_details?.name || "there";
  const email = session.customer_details?.email || "";

  const isPaidOrTrial =
    session?.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required");

  if (!isPaidOrTrial) {
    return sendHtml(res, errorPage("Payment not completed yet.", [
      `status=${session?.status}, payment_status=${session?.payment_status}`,
      "If you used an async method, wait for completion then refresh."
    ], name), 302);
  }

  // 2) Build a download URL
  let downloadUrl = null, hints = [];
  if (USE_DIRECT) {
    downloadUrl = process.env.DIRECT_DOWNLOAD_URL; // simplest path (host anywhere)
  } else if (HAS_S3) {
    try {
      const cmd = new s3.cmd({
        Bucket: process.env.AWS_BUCKET,
        Key: process.env.INSTALLER_KEY // e.g. releases/TrueTrend_Installer.zip
      });
      downloadUrl = await s3.presign(s3.client, cmd, { expiresIn: 60 });
    } catch (e) {
      hints.push("S3 presign failed. Check AWS creds, region, bucket, and INSTALLER_KEY.");
      hints.push(String(e?.message || e));
    }
  } else {
    hints.push("No DIRECT_DOWNLOAD_URL and no S3 configured.");
    hints.push("Set DIRECT_DOWNLOAD_URL for a quick win, or configure AWS_* and INSTALLER_KEY.");
  }

  // 3) Render the Thank-You page (auto-start download if we have a URL)
  const page = htmlPage({
    name, email,
    downloadUrl,
    hints
  });

  return sendHtml(res, page, downloadUrl ? 200 : 500);
}

// ---- PAGE TEMPLATES ---------------------------------------------------------
function htmlPage({ name, email, downloadUrl, hints }) {
  const auto = downloadUrl ? `
    <script>
      setTimeout(function(){
        try{ location.href = ${JSON.stringify(downloadUrl)}; }catch(e){}
      }, 800);
    </script>
  ` : "";

  const diag = hints?.length ? diagBlock(hints) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Thank You — TrueTrend Installer</title>
<style>
  :root{--bg:#0b1220;--card:#121a2b;--fg:#e7eefc;--muted:#9bb0d1;--accent:#16a34a}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .wrap{max-width:760px;margin:48px auto;padding:24px}
  .card{background:var(--card);border:1px solid #21304d;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  h1{margin:0 0 8px;font-size:28px}
  p{line-height:1.55;margin:10px 0}
  .muted{color:var(--muted);font-size:14px}
  .btn{display:inline-block;margin-top:14px;padding:12px 18px;border-radius:12px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600}
  .row{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .tag{background:#172440;border:1px solid #223457;border-radius:999px;padding:6px 10px;font-size:12px;color:#cfe1ff}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>✅ Payment Verified — Thanks, ${escapeHtml(name)}!</h1>
      <p>Your installer is ready${email ? ` for <b>${escapeHtml(email)}</b>` : ""}.</p>
      ${
        downloadUrl
        ? `<div class="row">
             <a class="btn" id="download" href="${escapeHtml(downloadUrl)}">⬇️ Download Installer (.zip)</a>
             <span class="tag">Link may expire quickly</span>
           </div>
           <p class="muted">If it expires, refresh this page to generate a new link.</p>`
        : `<p class="muted">We couldn't generate the download link yet.</p>`
      }
      ${diag}
    </div>
  </div>
  ${auto}
</body>
</html>`;
}

function errorPage(title, lines = [], name = "there") {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Installer — Setup needed</title>
<style>
  body{margin:0;background:#0b1220;color:#e7eefc;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .wrap{max-width:760px;margin:48px auto;padding:24px}
  .card{background:#121a2b;border:1px solid #21304d;border-radius:16px;padding:28px}
  h1{margin:0 0 8px;font-size:26px}
  .muted{color:#9bb0d1}
</style></head>
<body><div class="wrap"><div class="card">
<h1>Hi ${escapeHtml(name)}, one more tweak…</h1>
<p class="muted">${escapeHtml(title)}</p>
${diagBlock(lines)}
</div></div></body></html>`;
}
