const { connectLambda } = require('@netlify/blobs');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

// Proxies AI requests to Anthropic's API using a server-side API key. This exists because
// the app's AI features (Suggest, Smart Import, handwriting/calendar reading) were originally
// built to call api.anthropic.com directly from the browser — that only works inside Claude.ai's
// own artifact preview, which quietly injects the credentials. On a real deployed site there's
// no such thing, so those calls fail outright (no API key, and Anthropic's API doesn't allow
// arbitrary cross-origin browser calls anyway). Routing through this function is also the only
// safe way to do it: a real API key can never be shipped in browser-visible code, since anyone
// could copy it out and run up your bill.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  connectLambda(event);

  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const token = getBearerToken(event);
  const payload = verifyToken(token, secret);
  if (!payload) return json(401, { error: 'Not signed in' });

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_2;
  if (!apiKey) {
    return json(500, { error: 'AI features aren\'t set up yet — an Admin needs to add an ANTHROPIC_API_KEY environment variable in Netlify.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
  if (!body || !Array.isArray(body.messages)) return json(400, { error: 'Expected { model, max_tokens, messages }' });

  // Cap max_tokens server-side regardless of what the client asks for, so a bug or an
  // unusually large request can't run up an unexpectedly large bill in one call.
  const maxTokens = Math.min(Number(body.max_tokens) || 1000, 4000);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-5',
        max_tokens: maxTokens,
        // system is optional and only used by features that need to scope/guardrail the model
        // (e.g. the in-app assistant) — every other existing AI feature omits it and is
        // unaffected.
        ...(body.system ? { system: body.system } : {}),
        messages: body.messages,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return json(resp.status, { error: (data && data.error && data.error.message) || 'AI request failed' });
    return json(200, data);
  } catch (e) {
    return json(502, { error: 'Could not reach the AI service — please try again.' });
  }
};
