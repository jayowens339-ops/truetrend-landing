// /api/make-download-token.js
import Stripe from "stripe";
import crypto from "crypto";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// In-memory store (OK for testing). Use Redis/DB in production.
const TOKENS = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: "missing session_id" });

    const s = await stripe.checkout.sessions.retrieve(session_id);
    if (!s || s.payment_status !== "paid") return res.status(403).json({ error: "not paid" });

    const token = crypto.randomBytes(24).toString("hex");
    TOKENS.set(token, { session_id, exp: Date.now() + 30 * 60 * 1000 });
    return res.status(200).json({ token });
  } catch (err) {
    console.error("make-token error:", err);
    return res.status(500).json({ error: "cannot create token" });
  }
}

export function consumeToken(token) {
  const rec = TOKENS.get(token);
  if (!rec) return null;
  if (Date.now() > rec.exp) { TOKENS.delete(token); return null; }
  TOKENS.delete(token);
  return rec;
}
