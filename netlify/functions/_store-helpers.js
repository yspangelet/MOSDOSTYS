// Originally this wrapped @netlify/blobs' getStore to force consistency:'strong' on every read,
// as a fix for a real bug: a Director added a group activity, it saved successfully, and was
// missing on the very next page load, then reappeared on the load after that — a textbook
// eventual-consistency race (Netlify Blobs' default read mode can briefly return a
// not-yet-caught-up copy right after a write).
//
// That fix broke the entire app: consistency:'strong' requires the blob client to have an
// `uncachedEdgeURL`, which is only present when a store is constructed manually with an explicit
// siteID + API token (the "direct API access" method). It is never present on the environment
// context that `connectLambda(event)` sets up — which is how every function in this app gets its
// store access — so forcing 'strong' here made literally every blob read/write throw
// BlobsConsistencyError, which is what surfaced as 502s on login and every save. Reverted back to
// the SDK's default (eventual consistency) so the app works again; the rare disappear-then-
// reappear race this was meant to fix is real but narrow (a fresh page load landing on an
// edge copy within roughly a second of a write) and isn't fixable through this option in this
// environment — a real fix would need either a different storage backend or the heavier direct
// Netlify-API access path (its own separate token/setup), not a one-line change here.
//
// Kept as a pass-through (rather than reverting every file back to importing getStore directly
// from @netlify/blobs) so every call site in this app still goes through one shared place, in
// case a real fix for the underlying race becomes worth revisiting later.
const { getStore } = require('@netlify/blobs');

module.exports = { getStore };
