/**
 * Crawler identity.
 *
 * The User-Agent is truthful and self-describing on purpose. A site operator who
 * greps their logs for this string lands on a page that says who we are, what we
 * collect, how often, and how to make us stop. That is the minimum owed to
 * someone whose servers you are using without asking.
 *
 * `BOT_TOKEN` is also the token we match against robots.txt User-agent groups,
 * so a site can address us specifically:
 *
 *     User-agent: PositioningIndexBot
 *     Disallow: /
 *
 * ...and we will honour it. See src/crawl/robots.js.
 */

export const BOT_NAME = 'PositioningIndexBot';
export const BOT_VERSION = '1.0';

/** Lowercased token used for robots.txt group matching. */
export const BOT_TOKEN = BOT_NAME.toLowerCase();

/** Where a site operator can read about us and find an opt-out. */
export const CONTACT_URL = 'https://github.com/rushogen/positioning-index#crawling-policy';

export const USER_AGENT =
  `${BOT_NAME}/${BOT_VERSION} (+${CONTACT_URL}; marketing-page positioning research; ` +
  `one request per page per day; honours robots.txt)`;

/**
 * The one language preference this crawler ever expresses, on every request,
 * from every origin, forever.
 *
 * Content negotiation is a variable we can hold still, so we hold it still. A
 * header that varied with the machine -- or that was absent, letting each origin
 * pick a default -- would put a second uncontrolled locale input next to the one
 * we cannot control at all, which is the client IP. Pinning it means that when a
 * page does come back localised anyway, we know it was routed by address rather
 * than negotiated by request.
 *
 * `en-US` first rather than a bare `en` because it is explicit about the region
 * as well as the language, and because en-US matches the origin this index
 * treats as canonical (a GitHub Actions runner). `en;q=0.9` keeps any English
 * variant acceptable rather than risking a 406 or a fallback locale from a site
 * that only publishes `en-GB`.
 *
 * This reduces one source of variance. It does not eliminate geo-routing: sites
 * that pick a currency from the client IP -- notion.com/pricing among them --
 * ignore Accept-Language entirely. That residue is what src/crawl/origin.js and
 * the origin rules in src/diff.js exist to handle.
 */
export const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** Headers sent on every request. Deliberately boring; we do not pretend to be a browser. */
export function crawlHeaders(extra = {}) {
  return {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    'accept-language': ACCEPT_LANGUAGE,
    'accept-encoding': 'gzip',
    from: CONTACT_URL,
    ...extra,
  };
}

/**
 * Politeness floor. Even when robots.txt specifies no Crawl-delay, we never
 * touch the same host more often than this. One page per day per URL is the
 * product's actual requirement, so this is generous.
 */
export const MIN_HOST_INTERVAL_MS = 60_000;

/** How long a cached robots.txt stays valid before we re-fetch it. */
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on response bytes we will read into memory and parse. */
export const MAX_BODY_BYTES = 1_500_000;

/** Per-request network timeout. */
export const FETCH_TIMEOUT_MS = 12_000;
