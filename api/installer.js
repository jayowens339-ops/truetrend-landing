// One-file Thank-You + Download page for Stripe Checkout
// Usage: https://YOURDOMAIN.com/api/installer?session_id={CHECKOUT_SESSION_ID}
//
// Env vars (Vercel → Project Settings → Environment Variables):
// STRIPE_SECRET_KEY=sk_live_...
// AWS_ACCESS_KEY_ID=...
// AWS_SECRET_ACCESS_KEY=...
// AWS_REGION=us-east-1
// AWS_BUCKET=truetrend-downloads
// INSTALLER_KEY=releases/TrueTrend_Universal_Chrome_Extension_v4.3.3.5_with_QuickStart.zip
//
// If you use Vercel Blob instead of S3, ask me and I’ll swap the 9 lines that sign the URL.

import Stripe from "stripe";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const session_id = url.searchParams.get("session_id");

  if (!session_id) {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  // 1) Verify the checkout session
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  // Accept paid or "no payment required" (e.g., free trial start)
  const ok =
    session?.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required");

  if (!ok) {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  // 2) Create a short-lived signed URL to your private ZIP
  let signedUrl = "#";
  try {
    const cmd = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: process.env.INSTALLER_KEY
    });
    signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 }); // 60 seconds
  } catch (e) {
    console.error("sign error:", e);
  }

  // 3) Return a branded Thank-You page that auto-triggers the download
  const name = session.customer_details?.name || "there";
  const email = session.customer_details?.email || "";

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
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
      <h1>✅ Payment Complete — Thanks, ${escapeHtml(name)}!</h1>
      <p>Your purchase was verified${email ? ` for <b>${escapeHtml(email)}</b>` : ""}.</p>
      <p>The installer is ready. Your download should start automatically. If it doesn’t, click the button below.</p>

      <div class="row">
        <a class="btn" id="download" href="${signedUrl}">⬇️ Download Installer (.zip)</a>
        <span class="tag">Link expires in ~60s</span>
      </div>

      <p class="muted" id="status">If the link expires before you click it, refresh this page — we’ll generate a fresh link.</p>
    </div>
  </div>

<script>
  // Auto-trigger download after a brief delay (some browsers block instant nav)
  setTimeout(() => {
    try { location.href = document.getElementById('download').href; } catch {}
  }, 800);

  // If the signed URL times out, let the user refresh to get a new one.
  // (This page re-verifies your session and generates a new signed url.)
</script>
</body>
</html>`);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&#34;","'":"&#39;"
    }[s]));
  }
}
