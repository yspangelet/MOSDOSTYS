const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

// Optimizes the ORDER of a route's middle stops using Google's Routes API — the school itself
// (origin/destination) is never reordered, since the frontend never sends it as a waypoint to
// begin with (see aiOptimizeRoute in index.html). Uses routingPreference: TRAFFIC_AWARE (NOT
// TRAFFIC_AWARE_OPTIMAL — Google's Routes API flatly rejects combining optimizeWaypointOrder
// with TRAFFIC_AWARE_OPTIMAL) with a real departureTime for the route's actual scheduled time,
// so this reflects what traffic is really like at, say, 7:45am on a Tuesday — not whatever
// traffic happens to be like at the moment someone clicks the button, which could be optimizing
// a morning route on a Sunday afternoon. TRAFFIC_AWARE still genuinely factors in live traffic
// conditions; it just skips the extra latency of TRAFFIC_AWARE_OPTIMAL's fully exhaustive
// calculation, which isn't available with waypoint reordering anyway. A caller can instead pass
// optimizeOrder:false (Custom Trips only, see aiOptimizeCustomTrip) to keep whatever stop order
// it sends and just get real, traffic-aware timing for that exact order — in that mode
// TRAFFIC_AWARE_OPTIMAL is used instead, since nothing here is being reordered for it to conflict with.
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
  const { origin, destination, waypoints, departureTime, optimizeOrder } = body || {};
  if (!origin || !destination || !Array.isArray(waypoints)) {
    return json(400, { error: 'Expected { origin, destination, waypoints, departureTime }' });
  }
  // optimizeOrder defaults to true (existing behavior for regular routes, which never pass this
  // flag at all). Custom Trips can explicitly pass optimizeOrder:false to ask Google only for
  // real, traffic-aware timing on the stops exactly as given — e.g. a driver who already knows
  // the order they want to run (a fixed pickup sequence, a specific reason to visit stop 3
  // before stop 1) but still wants accurate arrival times instead of the flat estimate.
  const shouldOptimizeOrder = optimizeOrder !== false;

  const store = getStore(APP_STORE);
  const apiKey = await store.get(SK_PREFIX + 'googleMapsApiKey', { type: 'json' });
  if (!apiKey) {
    return json(400, { error: 'Google Maps is not connected yet — add an API key in Transportation → Integrations.' });
  }

  try {
    const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.optimizedIntermediateWaypointIndex,routes.duration,routes.distanceMeters,routes.legs',
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        intermediates: waypoints.map((w) => ({ address: w })),
        travelMode: 'DRIVE',
        routingPreference: shouldOptimizeOrder ? 'TRAFFIC_AWARE' : 'TRAFFIC_AWARE_OPTIMAL',
        departureTime,
        optimizeWaypointOrder: shouldOptimizeOrder,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return json(resp.status, { error: (data && data.error && data.error.message) || 'Google Maps request failed' });
    return json(200, data);
  } catch (e) {
    return json(502, { error: 'Could not reach Google Maps — please try again.' });
  }
};
