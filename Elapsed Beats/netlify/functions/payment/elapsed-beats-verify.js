// netlify/functions/elapsed-beats-verify.js
// Elapsed Beats calls this on the success redirect: "was this session really paid?"
// It asks Stripe directly — so a faked session ID in the URL cannot unlock Premium.
// Returns the Premium entitlement ONLY when Stripe confirms payment, and refuses
// to confirm the same session twice (replay protection) using Netlify Blobs storage.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-03-31.basil'
});
const { getStore } = require('@netlify/blobs');   // tiny built-in key/value store, no setup

exports.handler = async (event) => {
  try {
    const query = event.queryStringParameters || {};
    const id = query.session_id;
    const installationId = String(query.installation_id || '');

    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No session_id' }) };
    }
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(installationId)) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid browser installation' }) };
    }

    // Ask Stripe, the source of truth.
    const s = await stripe.checkout.sessions.retrieve(id);
    if (!s || s.payment_status !== 'paid') {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Not paid' }) };
    }

    // Confirm this is the Elapsed Beats Premium item bought by this browser.
    const metadata = s.metadata || {};
    if (
      metadata.kind !== 'premium' ||
      Number(metadata.tier) !== 1 ||
      metadata.installation_id !== installationId
    ) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Wrong purchase' }) };
    }

    // One-time only: if Premium was already granted for this session, do not grant it again.
    const store = getStore('elapsed-beats-premium-grants');
    const already = await store.get(id);
    if (already) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Already redeemed' }) };
    }
    await store.set(id, JSON.stringify({ at: Date.now(), installation_id: installationId, md: metadata }));

    // Tell Elapsed Beats exactly what to unlock. The HTML requires premium_v1.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, entitlement: 'premium_v1' }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
