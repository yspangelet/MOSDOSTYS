const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

// ============================================================================
// PAYMENT PROCESSOR — SCAFFOLDING ONLY.
//
// This function is the backend "shell" for online payments (tuition "Pay now", Fundraising
// online giving): real session auth, real settings lookup, and the three actions the frontend
// will eventually call — but NOT a real integration with any payment processor yet. Every
// processor has its own specific API shape (Stripe's Payment Intents/Customers and webhook
// signature scheme won't look like another processor's), so filling in the real charge/checkout/
// webhook-verification logic is deliberately left for a follow-up pass once a processor is
// actually chosen in Settings → Payment Processor and real keys exist to build and test against.
// Guessing at that shape now, before there's a real key to test with, would mean reworking it
// anyway — better to build it once, correctly, against the real thing.
//
// Actions this function already handles for real:
//   - 'test-connection' : confirms keys are saved and this function can read them. Does NOT yet
//                          call out to the processor itself to verify the keys are actually valid.
//
// Actions that are stubbed (return a clear "not implemented yet" error rather than pretending):
//   - 'create-checkout-session' : would create a real hosted checkout/payment-intent for a
//                                  tuition balance or a donation amount.
//   - 'webhook'                 : would receive and verify a "payment succeeded" notification
//                                  from the processor and record it as a real tuition payment /
//                                  donation automatically. NOTE: a real webhook is called BY the
//                                  processor (like transport-voice.js is called by Twilio), so it
//                                  will need its own signature-verification step instead of the
//                                  signed-in-session check below — left as a comment where that
//                                  belongs, once a processor's real signature scheme is wired in.
// ============================================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
  const { action } = body || {};

  // Every action below is called BY Ledger's own frontend with a real signed-in session — same
  // pattern as transport-sms.js/transport-call.js. A future real 'webhook' action would instead
  // be called BY the payment processor itself (no Ledger session available) and would need to
  // verify the processor's own webhook signature header here instead of a session token — see
  // the comment in the 'webhook' branch below.
  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const token = getBearerToken(event);
  const payload = verifyToken(token, secret);
  if (!payload) return json(401, { error: 'Not signed in' });

  const store = getStore(APP_STORE);
  const config = await store.get(SK_PREFIX + 'paymentProcessor', { type: 'json' });
  const configured = !!(config && config.secretKey && config.publishableKey);

  if (action === 'test-connection') {
    if (!configured) return json(400, { error: 'Add a publishable key and secret key in Settings → Payment Processor first.' });
    // A real check here would call the processor's own "who am I" endpoint (e.g. Stripe's
    // /v1/balance) with the secret key to confirm it's genuinely valid, not just present. That
    // real call is exactly the kind of processor-specific logic this scaffold intentionally
    // leaves for the follow-up pass — for now this only confirms the keys made it to the server.
    return json(200, { ok: true, message: `✓ ${config.provider || 'Processor'} keys are saved and reachable by the backend — real verification against ${config.provider || 'the processor'}'s own API isn't wired up yet.` });
  }

  if (action === 'create-checkout-session') {
    if (!configured || !config.enabled) return json(400, { error: 'Online payments are not enabled yet — connect and enable a processor in Settings → Payment Processor.' });
    // TODO (follow-up pass, once a processor is chosen): create a real checkout session /
    // payment intent with config.secretKey for body.amountCents, body.description,
    // body.studentId / body.donorId, etc., and return the real hosted-checkout URL or client
    // secret for the frontend to redirect to / confirm with. Left unimplemented on purpose.
    return json(501, { error: 'Payment processing isn\'t connected yet — the Settings screen and this function are ready, but the real checkout call still needs to be built against your chosen processor\'s API.' });
  }

  if (action === 'webhook') {
    // TODO (follow-up pass): a real webhook is called BY the processor, not by Ledger's
    // frontend — this branch will need to verify the processor's own signature header
    // (e.g. Stripe-Signature, checked against config.webhookSecret) INSTEAD OF the
    // signed-in-session check above, then record a tuitionPayment or donation automatically
    // once verified. Left unimplemented on purpose — no real webhook exists to receive yet.
    return json(501, { error: 'Webhook handling isn\'t implemented yet.' });
  }

  return json(400, { error: `Unknown action "${action}"` });
};
