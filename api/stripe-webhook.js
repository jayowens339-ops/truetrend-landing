// /api/stripe-webhook.js
import Stripe from "stripe";
import { Resend } from "resend";
import { kv } from "@vercel/kv";

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const resend = new Resend(process.env.RESEND_API_KEY);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function ensureLicense({ customerId, email, productId, status, currentPeriodEnd }) {
  // One license per customer+product (adjust if you sell multiple SKUs)
  const licenseKey = `LIC-${Math.random().toString(36).slice(2,10)}-${Math.random().toString(36).slice(2,10)}`.toUpperCase();

  const key = `license:${customerId}:${productId}`;
  const existing = await kv.hgetall(key);

  if (!existing) {
    await kv.hset(key, {
      licenseKey,
      customerId,
      productId,
      email: email || "",
      status, // 'trialing' | 'active' | ...
      currentPeriodEnd: currentPeriodEnd || 0,
      boundDevice: "",                // for single-device
      deviceLimit: 1,                 // enforce one device
      updatedAt: Date.now()
    });
    return { created: true, licenseKey };
  } else {
    await kv.hset(key, {
      status,
      currentPeriodEnd: currentPeriodEnd || existing.currentPeriodEnd || 0,
      updatedAt: Date.now()
    });
    return { created: false, licenseKey: existing.licenseKey };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["stripe-signature"];
  const raw = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature check failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle both one-time + subscription
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const productId = (s.metadata && s.metadata.productId) || "truetrend-ai";
    const status = s.mode === "subscription" ? "trialing" : "active";
    const periodEnd = s.subscription
      ? (await stripe.subscriptions.retrieve(s.subscription)).current_period_end * 1000
      : 0;

    const { licenseKey, created } = await ensureLicense({
      customerId: s.customer,
      email: s.customer_details?.email,
      productId,
      status,
      currentPeriodEnd: periodEnd
    });

    // Email the key once on creation
    if (created && s.customer_details?.email) {
      const link = `${process.env.NEXT_PUBLIC_SITE_URL}/activate.html?key=${encodeURIComponent(licenseKey)}`;
      await resend.emails.send({
        from: "TrueTrend <sales@trytruetrend.com>",
        to: s.customer_details.email,
        subject: "Your TrueTrend License Key",
        html: `<p>Thanks for your purchase!</p>
               <p>Your license key:</p>
               <p><b>${licenseKey}</b></p>
               <p>Click to activate: <a href="${link}">${link}</a></p>`
      });
    }
  }

  // Keep license status synced for subscriptions
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const sub = event.data.object;
    const productId = sub.items.data[0]?.price?.product || "truetrend-ai";
    const status = sub.status; // 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete'
    await ensureLicense({
      customerId: sub.customer,
      email: "",
      productId,
      status,
      currentPeriodEnd: sub.current_period_end * 1000
    });
  }

  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const obj = event.data.object;
    const customerId = obj.customer || obj.customer_id;
    const sub = event.type === "customer.subscription.deleted" ? obj : await stripe.subscriptions.retrieve(obj.subscription);
    const productId = sub.items.data[0]?.price?.product || "truetrend-ai";
    const key = `license:${customerId}:${productId}`;
    const existing = await kv.hgetall(key);
    if (existing) {
      await kv.hset(key, { status: "canceled", updatedAt: Date.now() });
    }
  }

  return res.json({ received: true });
}
