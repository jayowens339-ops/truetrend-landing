// /api/stripe-webhook.js
import Stripe from "stripe";
import { Resend } from "resend";

// Vercel will pass raw body if you read it like this:
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const resend = new Resend(process.env.RESEND_API_KEY);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      // Ask our API for a fresh one-time token
      const resp = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL}/api/make-download-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session.id }),
      });
      const { token } = await resp.json();
      const downloadUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/api/download?token=${encodeURIComponent(token)}`;

      if (session.customer_details?.email) {
        await resend.emails.send({
          from: "TrueTrend <sales@trytruetrend.com>",
          to: session.customer_details.email,
          subject: "Your TrueTrend Installer — Payment Confirmed",
          html: `
            <h2>Thanks for your purchase!</h2>
            <p>Your payment was successful. You can download your installer here:</p>
            <p><a href="${downloadUrl}">Download Installer (.zip)</a></p>
            <p><small>This link expires in ~30 minutes. If it expires, reply to this email for a refresh.</small></p>
          `,
        });
      }
    } catch (e) {
      console.error("email/send error:", e);
    }
  }

  return res.json({ received: true });
}
