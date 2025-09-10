// /api/gateway.js
// One-file gateway for checkout, thank-you page, download, email, license, and verify.
// Works on Vercel as a single Serverless Function.
//
// ENV VARS you must set in Vercel:
// STRIPE_SECRET_KEY=sk_live_...
// STRIPE_PRICE_ID=price_...
// STRIPE_WEBHOOK_SECRET=whsec_...
// NEXT_PUBLIC_SITE_URL=https://www.trytruetrend.com
// RESEND_API_KEY=re_...                 // or remove email section if not using Resend
// AWS_ACCESS_KEY_ID=...                 // if using S3 for the private zip
// AWS_SECRET_ACCESS_KEY=...
// AWS_REGION=us-east-1
// AWS_BUCKET=truetrend-downloads
// INSTALLER_KEY=releases/TrueTrend_Universal_Chrome_Extension_v4.3.3.5_with_QuickStart.zip
// KV_REST_API_URL=...                   // optional: for @vercel/kv
// KV_REST_API_TOKEN=...                 // optional
//
// Dependencies to add in package.json:
//  "stripe": "^14.0.0",
//  "resend": "^2.0.0",
//  "@aws-sdk/client-s3": "^3.593.0",
//  "@aws-sdk/s3-request-presigner": "^3.593.0",
//  "@vercel/kv": "^1.0.0"
//
// Stripe Dashboard
// - Success URL:  https://YOURDOMAIN.com/api/gateway?action=thanks&session_id={CHECKOUT_SESSION_ID}
// - Webhook URL:  https://YOURDOMAIN.com/api/gateway   (same endpoint)
//   (Stripe will send a 'stripe-signature' header; we detect it automatically.)

import Stripe from "stripe";
import { Resend } from "resend";
import crypto from "crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// KV is optional. If not configured, we fall back to in-memory (not durable across cold starts).
let kv = null;
try {
  const maybeKV = await import("@vercel/kv");
  kv = maybeKV.kv;
} catch (_) {
  // no-op
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
});

// In-memory fallback stores (ephemeral). Use KV in production.
const MEM_TOKENS = new Map();        // token -> { session_id, exp }
const MEM_LICENSES = new Map();      // license key -> record
const MEM_INDEX = new Map();         // licenseIndex:key -> {customerId, productId}

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
const PRODUCT_ID_DEFAULT = "truetrend-ai";
const GOOD_STATUSES = new Set(["active", "trialing"]);

// ---------- tiny KV wrappers ----------
async function kvHGetAll(key) {
  if (kv) return await kv.hgetall(key);
  return MEM_LICENSES.get(key) || null;
}
async function kvHSet(key, obj) {
  if (kv) return await kv.hset(key, obj);
  const prev = MEM_LICENSES.get(key) || {};
  MEM_LICENSES.set(key, { ...prev, ...obj });
}
async function kvDel(key) {
  if (kv) return await kv.del(key);
  MEM_LICENSES.delete(key);
}
async function kvIndexGet(key) {
  if (kv) return await kv.hgetall(key);
  return MEM_INDEX.get(key) || null;
}
async function kvIndexSet(key, obj) {
  if (kv) return await kv.hset(key, obj);
  MEM_INDEX.set(key, obj);
}

// ---------- token store ----------
function tokenSet(token, rec) {
  if (kv) {
    // store as hash-ish
    return kv.hset(`token:${token}`, { ...rec });
  }
  MEM_TOKENS.set(token, rec);
}
async function tokenConsume(token) {
  if (kv) {
    const rec = await kv.hgetall(`token:${token}`);
    if (!rec) return null;
    if (Date.now() > Number(rec.exp)) { await kvDel(`token:${token}`); return null; }
    await kvDel(`token:${token}`);
    return rec;
  }
  const rec = MEM_TOKENS.get(token);
  if (!rec) return null;
  if (Date.now() > rec.exp) { MEM_TOKENS.delete(token); return null; }
  MEM_TOKENS.delete(token);
  return rec;
}

// ---------- utils ----------
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function send(res, status, body, headers = {}) {
  const h = { "content-type": "application/json; charset=utf-8", ...headers };
  res.writeHead(status, h);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function html(res, status, markup) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(markup);
}
function randomKey(prefix = "LIC") {
  return `${prefix}-${Math.random().toString(36).slice(2,10)}-${Math.random().toString(36).slice(2,10)}`.toUpperCase();
}

// ---------- license helpers ----------
async function ensureLicense({ customerId, email, productId, status, currentPeriodEnd }) {
  const key = `license:${customerId}:${productId}`;
  const existing = await kvHGetAll(key);
  if (!existing || !existing.licenseKey) {
    const licenseKey = randomKey("LIC");
    await kvHSet(key, {
      licenseKey,
      customerId,
      productId,
      email: email || "",
      status,
      currentPeriodEnd: currentPeriodEnd || 0,
      boundDevice: "",
      deviceLimit: 1,
      updatedAt: Date.now()
    });
    await kvIndexSet(`licenseIndex:${licenseKey}`, { customerId, productId });
    return { created: true, licenseKey };
  } else {
    await kvHSet(key, {
      status,
      currentPeriodEnd: currentPeriodEnd || existing.currentPeriodEnd || 0,
      updatedAt: Date.now()
    });
    return { created: false, licenseKey: existing.licenseKey };
  }
}

async function getLicenseByKey(licenseKey, productId) {
  const idx = await kvIndexGet(`licenseIndex:${licenseKey}`);
  if (!idx) return null;
  const lic = await kvHGetAll(`license:${idx.customerId}:${productId}`);
  if (!lic) return null;
  return lic;
}

// ---------- actions ----------
async function actionCheckout(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",                          // switch to "subscription" if selling subs
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${SITE}/api/gateway?action=thanks&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/`,
      metadata: { productId: PRODUCT_ID_DEFAULT }
    });
    return send(res, 200, { url: session.url });
  } catch (err) {
    console.error("checkout error:", err);
    return send(res, 500, { error: "Unable to create session" });
  }
}

async function actionThanks(req, res, query) {
  // Renders the thank-you page as HTML (server-side)
  const session_id = query.get("session_id");
  if (!session_id) return html(res, 302, `<meta http-equiv="refresh" content="0;url=/" />`);

  try {
    const s = await stripe.checkout.sessions.retrieve(session_id);
    if (!s || s.payment_status !== "paid") return html(res, 302, `<meta http-equiv="refresh" content="0;url=/" />`);

    // issue one-time token
    const token = crypto.randomBytes(24).toString("hex");
    await tokenSet(token, { session_id, exp: Date.now() + 30 * 60 * 1000 });

    const dl = `${SITE}/api/gateway?action=download&token=${encodeURIComponent(token)}`;
    const name = (s.customer_details && s.customer_details.name) || "there";
    return html(res, 200, `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Thank You — TrueTrend</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;max-width:720px;margin:40px auto;padding:24px}
a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:10px;background:#16a34a;color:#fff;text-decoration:none;font-weight:600}
.muted{font-size:14px;opacity:.8}
</style>
</head>
<body>
  <h1>✅ Payment Complete — Thank You!</h1>
  <p>Hi ${name}, your payment was successful.</p>
  <p>You can install the product now, or use the email we just sent you.</p>
  <p><a class="btn" href="${dl}">⬇️ Download Installer (.zip)</a></p>
  <p class="muted">This link expires in ~30 minutes. You can always reply to your receipt email for a fresh link.</p>
</body></html>`);
  } catch (e) {
    return html(res, 302, `<meta http-equiv="refresh" content="0;url=/" />`);
  }
}

async function actionMakeToken(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const body = await parseJSON(req);
    const session_id = body?.session_id;
    if (!session_id) return send(res, 400, { error: "missing session_id" });

    const s = await stripe.checkout.sessions.retrieve(session_id);
    if (!s || s.payment_status !== "paid") return send(res, 403, { error: "not paid" });

    const token = crypto.randomBytes(24).toString("hex");
    await tokenSet(token, { session_id, exp: Date.now() + 30 * 60 * 1000 });
    return send(res, 200, { token });
  } catch (err) {
    console.error("make-token error:", err);
    return send(res, 500, { error: "cannot create token" });
  }
}

async function actionDownload(req, res, query) {
  const token = query.get("token");
  if (!token) return send(res, 400, { error: "missing token" });

  try {
    const rec = await tokenConsume(token);
    if (!rec) return send(res, 403, { error: "invalid or expired token" });

    const cmd = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: process.env.INSTALLER_KEY
    });
    const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 });
    res.writeHead(302, { Location: signed });
    return res.end();
  } catch (err) {
    console.error("download error:", err);
    return send(res, 500, { error: "download failed" });
  }
}

async function actionVerify(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const { licenseKey, deviceId, productId = PRODUCT_ID_DEFAULT } = await parseJSON(req) || {};
    if (!licenseKey || !deviceId) return send(res, 400, { error: "missing fields" });

    const lic = await getLicenseByKey(licenseKey, productId);
    if (!lic) return send(res, 403, { active: false, status: "not_found" });

    // single-device
    let bound = lic.boundDevice || "";
    const licKey = `license:${lic.customerId}:${productId}`;
    if (!bound) {
      await kvHSet(licKey, { boundDevice: deviceId, updatedAt: Date.now() });
      bound = deviceId;
    } else if (bound !== deviceId) {
      return send(res, 403, { active: false, status: "device_limit" });
    }

    const now = Date.now();
    const valid =
      GOOD_STATUSES.has(lic.status) &&
      (Number(lic.currentPeriodEnd) === 0 || now <= Number(lic.currentPeriodEnd) + 5 * 60 * 1000);

    return send(res, 200, {
      active: !!valid,
      status: lic.status,
      validUntil: Number(lic.currentPeriodEnd) || 0
    });
  } catch (e) {
    console.error("verify error:", e);
    return send(res, 500, { error: "server error" });
  }
}

// Stripe webhook (same endpoint). Auto-detect by signature header.
async function handleStripeWebhook(req, res) {
  const raw = await readRawBody(req);
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return send(res, 400, `Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const productId = (s.metadata && s.metadata.productId) || PRODUCT_ID_DEFAULT;
    const status = s.mode === "subscription" ? "trialing" : "active";
    const periodEnd = s.subscription
      ? (await stripe.subscriptions.retrieve(s.subscription)).current_period_end * 1000
      : 0;

    const { licenseKey, created } = await ensureLicense({
      customerId: s.customer,
      email: s.customer_details?.email || "",
      productId,
      status,
      currentPeriodEnd: periodEnd
    });

    // Email license + download link
    if (resend && s.customer_details?.email) {
      // fresh token for email
      const token = crypto.randomBytes(24).toString("hex");
      await tokenSet(token, { session_id: s.id, exp: Date.now() + 30 * 60 * 1000 });
      const downloadUrl = `${SITE}/api/gateway?action=download&token=${encodeURIComponent(token)}`;
      await resend.emails.send({
        from: "TrueTrend <sales@trytruetrend.com>",
        to: s.customer_details.email,
        subject: "Your TrueTrend — Payment Confirmed",
        html: `
          <h2>Thanks for your purchase!</h2>
          <p>Your license key: <b>${licenseKey}</b></p>
          <p>Download your installer: <a href="${downloadUrl}">Download (.zip)</a></p>
          <p><small>Link expires in 30 minutes. Need a fresh link? Reply to this email.</small></p>
        `
      });
    }
  }

  // keep subs in sync
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    const productId = sub.items.data[0]?.price?.product || PRODUCT_ID_DEFAULT;
    await ensureLicense({
      customerId: sub.customer,
      email: "",
      productId,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end * 1000
    });
  }

  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const obj = event.data.object;
    const customerId = obj.customer || obj.customer_id;
    const sub = event.type === "customer.subscription.deleted" ? obj : await stripe.subscriptions.retrieve(obj.subscription);
    const productId = sub.items.data[0]?.price?.product || PRODUCT_ID_DEFAULT;
    const key = `license:${customerId}:${productId}`;
    const existing = await kvHGetAll(key);
    if (existing) await kvHSet(key, { status: "canceled", updatedAt: Date.now() });
  }

  return send(res, 200, { received: true });
}

// parses JSON (not used for webhook)
async function parseJSON(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ---------- main handler ----------
export default async function handler(req, res) {
  // If Stripe webhook, process first (raw body + signature)
  if (req.headers["stripe-signature"]) {
    return handleStripeWebhook(req, res);
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  try {
    if (action === "checkout") return actionCheckout(req, res);
    if (action === "thanks")   return actionThanks(req, res, url.searchParams);
    if (action === "token")    return actionMakeToken(req, res);
    if (action === "download") return actionDownload(req, res, url.searchParams);
    if (action === "verify")   return actionVerify(req, res);

    // basic help
    return send(res, 200, {
      ok: true,
      actions: ["checkout (POST)", "thanks (GET)", "download (GET)", "verify (POST)", "token (POST)"],
      note: "Stripe webhooks also post here automatically."
    });
  } catch (e) {
    console.error("gateway fatal:", e);
    return send(res, 500, { error: "server error" });
  }
}
