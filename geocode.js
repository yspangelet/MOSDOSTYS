const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

// Turns a stop's address text into real coordinates, using the same Google Maps API key already
// stored for route optimization (Geocoding and Routes are just two separately-enabled APIs on
// the same key/project, so there's nothing new to connect). This is what lets route generation
// cluster and order stops by actual straight-line distance instead of an AI reading street names
// and guessing what's nearby — see clusterStopsByRealDistance in index.html.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  connectLambda(event);

  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const token = getBearerToken(event);
  const payload = verifyToken(token, secret);
  if (!payload) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
  const address = body && body.address && String(body.address).trim();
  if (!address) return json(400, { error: 'Expected { address }' });

  const store = getStore(APP_STORE);
  const apiKey = await store.get(SK_PREFIX + 'googleMapsApiKey', { type: 'json' });
  if (!apiKey) {
    return json(400, { error: 'Google Maps is not connected yet — add an API key in Transportation → Integrations.' });
  }

  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + apiKey;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results || !data.results.length) {
      // Not a hard failure — an address the geocoder can't resolve (typo, incomplete, informal
      // cross-street) is common and expected sometimes; the caller falls back to the older
      // AI-text-reasoning path for whichever specific stops come back this way, rather than the
      // whole batch failing.
      return json(200, { ok: false, status: data.status, error: data.error_message || 'No match found for that address' });
    }
    const top = data.results[0];
    return json(200, {
      ok: true,
      lat: top.geometry.location.lat,
      lng: top.geometry.location.lng,
      formattedAddress: top.formatted_address,
      locationType: top.geometry.location_type, // ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER / APPROXIMATE — surfaced so a very approximate match can be flagged rather than trusted as exact
    });
  } catch (e) {
    return json(502, { error: 'Could not reach Google Maps — please try again.' });
  }
};
