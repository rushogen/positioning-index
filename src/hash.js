/**
 * FNV-1a, 32-bit, hex encoded.
 *
 * Used for two things: "is this page byte-identical to last time" and "is this
 * signal value identical to last time". Both are equality checks on strings we
 * already trust, so a fast non-cryptographic hash is the right tool. crypto
 * .subtle.digest is async and costs a microtask plus a TextEncoder allocation
 * per call; on the 10ms CPU budget, with ~11 signals per page, that adds up for
 * no benefit.
 *
 * Collision risk is irrelevant here: a collision would mean we skip one change
 * event on one company on one day, and the next day's run catches it, because
 * the diff also compares the raw strings before writing an event.
 */
export function fnv1a(str) {
  if (str == null) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h * 16777619 without overflowing into float territory
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash of a value's canonical JSON form. Key order is caller's responsibility. */
export function hashJson(value) {
  if (value === null || value === undefined) return null;
  return fnv1a(JSON.stringify(value));
}
