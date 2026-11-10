// netlify/functions/checkout.js
// Creates a Stripe Checkout Session for one store item and returns its hosted URL.
// The browser NEVER sees the secret key — it lives only in a Netlify env var.
//
// ── BEFORE THIS WORKS, FILL IN TWO THINGS ───────────────────────────────
//   PRICE_MAP and SITE_URL are filled in for elapsedbeatswidget.netlify.app.
//   The only thing left is the dashboard secret:
//   In the Netlify dashboard (Site settings → Environment variables) add:
//      STRIPE_SECRET_KEY = [add your Stripe secret key in Netlify]
// ────────────────────────────────────────────────────────────────────────

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-03-31.basil'
});

// Price ID for the Elapsed Beats Premium purchase.
// kind → array indexed by tier n (1..1).
const PRICE_MAP = {
  premium: ['price_1U7fxcFwZhAIAXKtn2k22FU7']
};

const SITE_URL = 'https://elapsedbeatswidget.netlify.app';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const request = JSON.parse(event.body || '{}');
    // Elapsed Beats currently sends installation_id instead of Cyclone's kind/tier.
    // Because Premium is the only purchase, safely default to that item and tier.
    const kind = request.kind || 'premium';
    const n = parseInt(request.tier || '1', 10);
    const priceId = PRICE_MAP[kind] && PRICE_MAP[kind][n - 1];
    if (!priceId) return { statusCode: 400, body: JSON.stringify({ error: 'Unknown item' }) };

    const metadata = { kind, tier: String(n) };
    if (request.installation_id) {
      metadata.installation_id = String(request.installation_id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      // What was bought travels with the session so the app can grant it after verifying.
      metadata,
      // Stripe sends the buyer here when done; {CHECKOUT_SESSION_ID} is filled in by Stripe.
      success_url: `${SITE_URL}/?premium_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/?premium_canceled=1`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
