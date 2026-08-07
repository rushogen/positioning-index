/**
 * robots.txt: a real parser and matcher, following RFC 9309.
 *
 * This is not decoration. The whole project rests on only ever reading pages
 * that the site has said we may read, from an identified client, at a rate that
 * costs them nothing. GummySearch had 140,000 users and was killed overnight by
 * a platform policy change; the lesson is not "avoid APIs", it is "do not build
 * on access you have not earned". Public pages fetched politely are access you
 * can keep.
 *
 * The owner of this index is in Germany. Under the DSGVO/UrhG framing, an
 * automated retrieval that ignores a machine-readable reservation of rights is
 * not a grey area, it is a documented refusal being overridden. So the parser
 * is strict and it fails CLOSED: if robots.txt cannot be parsed, or the fetch
 * for it errors in a way that suggests the server is deliberately refusing us,
 * we do not crawl.
 *
 * Implemented from RFC 9309:
 *  - group selection: the most specific matching User-agent token wins, with
 *    `*` as the fallback group. Case-insensitive.
 *  - rule precedence: the LONGEST matching path wins, not the first. Allow wins
 *    ties. (Section 2.2.2.)
 *  - `*` matches any sequence, `$` anchors the end of the path.
 *  - percent-encoding is normalised on both sides before matching.
 *  - an empty Disallow means "allow everything".
 *  - Crawl-delay is not in the RFC but is widely deployed and widely meant, so
 *    we honour it.
 */

import { BOT_TOKEN, ROBOTS_TTL_MS, USER_AGENT, crawlHeaders, FETCH_TIMEOUT_MS } from './agent.js';

/**
 * Parse a robots.txt body into groups.
 *
 * @returns {{groups: Map<string, {allow: string[], disallow: string[], crawlDelay: number|null}>, sitemaps: string[]}}
 */
export function parseRobots(body) {
  const groups = new Map();
  const sitemaps = [];
  if (typeof body !== 'string') return { groups, sitemaps };

  /** Agents named by the group currently being built. */
  let currentAgents = [];
  /** True once a rule line has been seen, so a following User-agent starts a new group. */
  let seenRule = false;

  for (const rawLine of body.split(/\r?\n/)) {
    // Comments run to end of line; a bare '#' line is a comment.
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (seenRule) { currentAgents = []; seenRule = false; }
      const token = value.toLowerCase();
      currentAgents.push(token);
      if (!groups.has(token)) groups.set(token, { allow: [], disallow: [], crawlDelay: null, contentSignals: {} });
      continue;
    }

    if (field === 'sitemap') { sitemaps.push(value); continue; }

    if (currentAgents.length === 0) continue;

    if (field === 'allow' || field === 'disallow') {
      seenRule = true;
      // "Disallow:" with an empty value means allow everything; it is not a rule.
      if (field === 'disallow' && value === '') continue;
      if (value === '') continue;
      for (const a of currentAgents) groups.get(a)[field === 'allow' ? 'allow' : 'disallow'].push(value);
      continue;
    }

    if (field === 'crawl-delay') {
      seenRule = true;
      const n = Number.parseFloat(value.replace(',', '.'));
      if (Number.isFinite(n) && n >= 0 && n < 3600) {
        for (const a of currentAgents) groups.get(a).crawlDelay = n;
      }
      continue;
    }

    // Content Signals (content-signals.org, shipped by Cloudflare in 2025 and
    // now present on a real share of the seed list -- vercel.com carries one).
    // Format: `Content-Signal: search=yes, ai-input=yes, ai-train=no`.
    //
    // These are a machine-readable statement of intent about downstream USE,
    // not about retrieval. Ignoring them would be exactly the posture this
    // project exists to argue against, so they are parsed and honoured.
    if (field === 'content-signal') {
      for (const part of value.split(',')) {
        const [k, v] = part.split('=').map((x) => x?.trim().toLowerCase());
        if (!k || (v !== 'yes' && v !== 'no')) continue;
        for (const a of currentAgents) groups.get(a).contentSignals[k] = v === 'yes';
      }
    }
  }

  return { groups, sitemaps };
}

/**
 * What this crawler does with content, expressed in Content Signals terms.
 *
 * We read a public marketing page and record a handful of short factual strings
 * from it (the headline, the tier names) so that they can be compared with the
 * same page tomorrow. That is an indexing activity. We do not train models on
 * it and we do not feed it to a generative system, so `ai-train=no` and
 * `ai-input=no` cost us nothing and are honoured trivially.
 *
 * `search=no` is the one that would bind us, and we treat it as an opt-out.
 */
export const OUR_USE = 'search';

/** Does the site's Content-Signal declaration permit what we do? */
export function contentSignalAllows(group) {
  if (!group || !group.contentSignals) return true;
  const declared = group.contentSignals[OUR_USE];
  return declared !== false;
}

/**
 * Select the group that applies to us.
 *
 * RFC 9309 2.2.1: the crawler picks the group whose User-agent token is the
 * longest match against its own product token. We check for our exact token
 * first, then any token that is a prefix of it, then `*`.
 */
export function selectGroup(groups, agentToken = BOT_TOKEN) {
  if (groups.has(agentToken)) return { group: groups.get(agentToken), matched: agentToken };

  let best = null;
  let bestToken = null;
  for (const [token, group] of groups) {
    if (token === '*') continue;
    if (agentToken.startsWith(token) && (bestToken === null || token.length > bestToken.length)) {
      best = group;
      bestToken = token;
    }
  }
  if (best) return { group: best, matched: bestToken };

  if (groups.has('*')) return { group: groups.get('*'), matched: '*' };
  return { group: null, matched: null };
}

/** Normalise a path for comparison: decode what is safe, keep the rest verbatim. */
function normalisePath(path) {
  let p = path || '/';
  try {
    // Decoding then re-encoding would change semantics; only fold the encodings
    // that are unambiguously equivalent.
    p = p.replace(/%2[fF]/g, '%2F').replace(/%7[eE]/g, '~');
  } catch { /* leave as-is */ }
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Does a robots.txt pattern match a path?
 *
 * Supports `*` (any sequence, including empty) and a trailing `$` (end anchor).
 * Everything else is a literal prefix match.
 */
export function patternMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  if (!body.includes('*')) {
    return anchored ? path === body : path.startsWith(body);
  }

  // Greedy segment walk. Linear in the path length, no regex construction and
  // therefore no way to hand a hostile robots.txt a catastrophic pattern.
  const segments = body.split('*');
  let cursor = 0;

  if (segments[0]) {
    if (!path.startsWith(segments[0])) return false;
    cursor = segments[0].length;
  }

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '') continue;
    const isLast = i === segments.length - 1;
    if (isLast && anchored) {
      if (!path.endsWith(seg)) return false;
      return path.length - seg.length >= cursor;
    }
    const at = path.indexOf(seg, cursor);
    if (at === -1) return false;
    cursor = at + seg.length;
  }

  if (anchored && segments[segments.length - 1] === '') return true;
  return anchored ? cursor === path.length : true;
}

/**
 * Decide whether a URL may be fetched.
 *
 * @returns {{allowed: boolean, rule: string|null, matchedAgent: string|null, crawlDelay: number|null, reason: string}}
 */
export function isAllowed(robotsBody, url, agentToken = BOT_TOKEN) {
  const path = normalisePath(new URL(url).pathname + (new URL(url).search || ''));
  const { groups } = parseRobots(robotsBody);
  const { group, matched } = selectGroup(groups, agentToken);

  if (!group) {
    return { allowed: true, rule: null, matchedAgent: null, crawlDelay: null, contentSignals: {}, reason: 'no applicable group in robots.txt' };
  }

  // RFC 9309 2.2.2: the most specific (longest) matching rule wins; Allow wins ties.
  let bestAllow = null;
  let bestDisallow = null;
  for (const p of group.allow) {
    if (patternMatches(p, path) && (bestAllow === null || p.length > bestAllow.length)) bestAllow = p;
  }
  for (const p of group.disallow) {
    if (patternMatches(p, path) && (bestDisallow === null || p.length > bestDisallow.length)) bestDisallow = p;
  }

  const crawlDelay = group.crawlDelay;
  const contentSignals = group.contentSignals ?? {};

  // A Content-Signal opt-out for our kind of use overrides any Allow rule.
  if (!contentSignalAllows(group)) {
    return {
      allowed: false, rule: `Content-Signal: ${OUR_USE}=no`, matchedAgent: matched,
      crawlDelay, contentSignals,
      reason: `site declares ${OUR_USE}=no via Content-Signal`,
    };
  }

  if (bestDisallow === null) {
    return { allowed: true, rule: bestAllow, matchedAgent: matched, crawlDelay, contentSignals, reason: 'no matching Disallow' };
  }
  if (bestAllow !== null && bestAllow.length >= bestDisallow.length) {
    return { allowed: true, rule: bestAllow, matchedAgent: matched, crawlDelay, contentSignals, reason: `Allow: ${bestAllow} is at least as specific as Disallow: ${bestDisallow}` };
  }
  return { allowed: false, rule: bestDisallow, matchedAgent: matched, crawlDelay, contentSignals, reason: `Disallow: ${bestDisallow}` };
}

/**
 * How a robots.txt HTTP status should be interpreted.
 *
 * RFC 9309 2.3.1:
 *   2xx  -> use the body
 *   4xx  -> no restrictions (the file genuinely does not exist)
 *   5xx  -> the server is unwilling or unable to answer. The RFC says treat as
 *           complete disallow. We do exactly that, which is the fail-closed
 *           behaviour this project wants anyway.
 *   401/403 are singled out: they are an explicit refusal, not an absence.
 */
export function interpretRobotsStatus(status) {
  if (status >= 200 && status < 300) return { usable: true, defaultAllow: null };
  if (status === 401 || status === 403) return { usable: false, defaultAllow: false, reason: `robots.txt returned ${status}: access explicitly refused` };
  if (status >= 400 && status < 500) return { usable: false, defaultAllow: true, reason: `robots.txt returned ${status}: treated as no restrictions` };
  return { usable: false, defaultAllow: false, reason: `robots.txt returned ${status}: server unwilling to answer, failing closed` };
}

/**
 * Fetch and cache robots.txt for a host.
 *
 * `store` is a tiny interface, so this is testable without touching disk:
 *   get(host) -> {body, http_status, expires_at, crawl_delay_s} | null
 *   put(host, record) -> void
 *
 * Note the robots.txt fetch itself counts as a request to the host, which is
 * why it is cached for a day: over a 60-company index that is 60 extra requests
 * per day total, one per host.
 */
export async function loadRobots(host, store, { now = Date.now(), fetchImpl = fetch } = {}) {
  const cached = await store.get(host);
  if (cached && Date.parse(cached.expires_at) > now) {
    return { ...cached, cached: true };
  }

  const url = `https://${host}/robots.txt`;
  let status = 0;
  let body = null;
  let error = null;

  try {
    const res = await fetchImpl(url, {
      headers: crawlHeaders({ accept: 'text/plain,*/*;q=0.1' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    status = res.status;
    if (status >= 200 && status < 300) {
      // robots.txt files are small; anything huge is not a robots.txt.
      body = (await res.text()).slice(0, 512_000);
    }
  } catch (err) {
    error = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err);
  }

  const interp = error
    ? { usable: false, defaultAllow: false, reason: `robots.txt fetch failed (${error}), failing closed` }
    : interpretRobotsStatus(status);

  const crawlDelay = body ? selectGroup(parseRobots(body).groups).group?.crawlDelay ?? null : null;

  const record = {
    host,
    body,
    http_status: status || null,
    fetched_at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    expires_at: new Date(now + ROBOTS_TTL_MS).toISOString().replace(/\.\d+Z$/, 'Z'),
    crawl_delay_s: crawlDelay,
    fetch_error: error,
    usable: interp.usable,
    defaultAllow: interp.defaultAllow,
    reason: interp.reason ?? null,
  };

  await store.put(host, record);
  return { ...record, cached: false };
}

/**
 * The single call the crawler makes: may we fetch this URL right now, and how
 * long must we wait between requests to this host?
 */
export async function checkUrl(url, store, opts = {}) {
  const host = new URL(url).hostname;
  const robots = await loadRobots(host, store, opts);

  if (robots.body == null) {
    return {
      allowed: robots.defaultAllow === true,
      crawlDelay: null,
      matchedAgent: null,
      reason: robots.reason ?? 'robots.txt unavailable',
      host,
    };
  }

  const verdict = isAllowed(robots.body, url);
  return { ...verdict, host, userAgent: USER_AGENT };
}
