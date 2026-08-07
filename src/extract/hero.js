/**
 * Hero-block signals: headline, subhead, category label, and the two meta tags.
 *
 * Everything here is a heuristic with a declared confidence. When a strategy
 * fails we fall through to a weaker one and say so in `method`, so that a
 * change from `h1` to `og:title` is visible downstream as a possible parser
 * problem rather than being silently laundered into a positioning change.
 */

import {
  HERO_WINDOW, attr, clean, collapse, elements, firstElement, headingText, jsonLd, meta, text,
} from './html.js';

const ok = (value, method, confidence, json) =>
  value ? { value, method, confidence, ...(json !== undefined ? { json } : {}) } : null;

// ---------------------------------------------------------------------------
// meta title / description
// ---------------------------------------------------------------------------

export function extractMetaTitle(doc, raw) {
  const t = firstElement(doc, 'title', { maxInner: 600 });
  const fromTag = t ? clean(text(t.inner), 300) : null;
  if (fromTag) return ok(fromTag, 'title', 1.0);

  const og = meta(doc, 'og:title') ?? meta(raw ?? doc, 'og:title');
  if (og) return ok(clean(og, 300), 'og:title', 0.7);
  return null;
}

export function extractMetaDescription(doc) {
  const d = meta(doc, 'description');
  if (d) return ok(clean(d, 500), 'meta:description', 1.0);
  const og = meta(doc, 'og:description');
  if (og) return ok(clean(og, 500), 'og:description', 0.8);
  const tw = meta(doc, 'twitter:description');
  if (tw) return ok(clean(tw, 500), 'twitter:description', 0.6);
  return null;
}

// ---------------------------------------------------------------------------
// headline
// ---------------------------------------------------------------------------

const HIDDEN_CLASS = /(?:^|[\s"'_-])(?:sr-only|sronly|visually-?hidden|screen-?reader(?:-only)?|a11y-only|hidden)(?:$|[\s"'_-])/i;

/** An <h1> that exists only for screen readers is not the positioning claim. */
export function isHidden(tag) {
  if (!tag) return false;
  if (/\shidden(?:[\s>=]|$)/i.test(tag)) return true;
  if (/aria-hidden\s*=\s*["']?true/i.test(tag)) return true;
  const cls = attr(tag, 'class');
  if (cls && HIDDEN_CLASS.test(cls)) return true;
  const style = attr(tag, 'style');
  if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  return false;
}

const MIN_HEADLINE = 8;
const MAX_HEADLINE = 200;

/** Nav and utility strings that show up as an <h1> on badly marked-up sites. */
const HEADLINE_JUNK = /^(?:home|menu|navigation|skip to (?:main )?content|search|log ?in|sign ?up|cookie|welcome)$/i;

function acceptableHeadline(value, brand) {
  if (!value) return false;
  if (value.length < MIN_HEADLINE || value.length > MAX_HEADLINE) return false;
  if (HEADLINE_JUNK.test(value)) return false;
  // A bare brand name is a logo, not a claim.
  if (brand && value.toLowerCase() === brand.toLowerCase()) return false;
  if (!/[a-z]/i.test(value)) return false;
  return true;
}

/**
 * Returns the winning headline plus the document offset it was found at, so the
 * subhead extractor can look at what physically follows it.
 */
export function extractHeadline(doc, { brand } = {}) {
  const hero = doc.slice(0, HERO_WINDOW);

  for (const scope of [
    { html: hero, method: 'h1', confidence: 1.0, offset: 0 },
    { html: doc, method: 'h1-below-fold', confidence: 0.75, offset: 0 },
  ]) {
    for (const el of elements(scope.html, 'h1', { limit: 20, maxInner: 8000 })) {
      if (isHidden(el.tag)) continue;
      const value = clean(headingText(el.inner), MAX_HEADLINE);
      if (!acceptableHeadline(value, brand)) continue;
      return { ...ok(value, scope.method, scope.confidence), index: el.index + el.tag.length };
    }
  }

  // Some design systems render the hero heading as a div with an ARIA role.
  const ariaRe = /<[a-z]+\b[^>]*role\s*=\s*["']?heading["']?[^>]*>/gi;
  let m;
  let seen = 0;
  while ((m = ariaRe.exec(hero)) !== null && seen++ < 10) {
    if (!/aria-level\s*=\s*["']?1["']?/i.test(m[0])) continue;
    if (isHidden(m[0])) continue;
    const slice = hero.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const value = clean(text(slice.split(/<\/(?:div|h1|h2|span|p)>/i)[0]), MAX_HEADLINE);
    if (acceptableHeadline(value, brand)) {
      return { ...ok(value, 'aria-heading', 0.7), index: m.index + m[0].length };
    }
  }

  // Last resort: og:title, but only when it is not just the brand or the
  // <title> tag repeated. This is a weak signal and is scored as such.
  const og = clean(meta(doc, 'og:title'), MAX_HEADLINE);
  if (acceptableHeadline(og, brand) && /\s/.test(og)) {
    return { ...ok(og, 'og:title-fallback', 0.4), index: -1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// subhead
// ---------------------------------------------------------------------------

const MIN_SUB = 20;
const MAX_SUB = 400;
const SUBHEAD_LOOKAHEAD = 6000;

export function extractSubhead(doc, headline) {
  if (headline && headline.index >= 0) {
    const window = doc.slice(headline.index, headline.index + SUBHEAD_LOOKAHEAD);
    for (const tag of ['p', 'h2', 'h3']) {
      for (const el of elements(window, tag, { limit: 12, maxInner: 4000 })) {
        if (isHidden(el.tag)) continue;
        const value = clean(headingText(el.inner), MAX_SUB);
        if (!value || value.length < MIN_SUB || value.length > MAX_SUB) continue;
        if (headline.value && value === headline.value) continue;
        // Reject legal/nav boilerplate that sometimes sits next to a hero.
        if (/^(?:by (?:clicking|signing)|we use cookies|terms|privacy)/i.test(value)) continue;
        return ok(value, `${tag}-after-h1`, tag === 'p' ? 0.9 : 0.7);
      }
    }
  }

  const og = clean(meta(doc, 'og:description'), MAX_SUB);
  if (og && og.length >= MIN_SUB) return ok(og, 'og:description-fallback', 0.35);
  return null;
}

// ---------------------------------------------------------------------------
// category label
//
// The noun a company chooses for itself is the most compressed statement of
// positioning they publish. "Project management tool" -> "platform" ->
// "system of record" -> "AI agent for engineering" is a strategy change you can
// read off a single word, which is why it gets its own signal.
// ---------------------------------------------------------------------------

/** Ordered longest-first so multi-word categories win over their substrings. */
const CATEGORY_NOUNS = [
  'customer data platform', 'customer engagement platform', 'revenue intelligence platform',
  'developer experience platform', 'application development platform',
  'system of record', 'system of action', 'source of truth', 'operating system',
  'command center', 'command centre', 'control plane', 'data warehouse', 'data cloud',
  'knowledge base', 'design tool', 'work management platform', 'single source of truth',
  'connected workspace', 'all-in-one platform', 'developer platform', 'data platform',
  'automation platform', 'engagement platform', 'intelligence platform', 'collaboration platform',
  'lakehouse', 'warehouse', 'infrastructure', 'marketplace', 'workspace', 'framework',
  'helpdesk', 'copilot', 'assistant', 'teammate', 'notebook', 'directory', 'dashboard',
  'automation', 'toolkit', 'platform', 'database', 'registry', 'planner', 'tracker',
  'whiteboard', 'workbench', 'repository', 'pipeline', 'gateway', 'runtime', 'sandbox',
  'canvas', 'studio', 'console', 'ledger', 'cloud', 'graph', 'mesh', 'fabric', 'desk',
  'browser', 'builder', 'network', 'service', 'software', 'solution', 'suite', 'system',
  'engine', 'editor', 'inbox', 'layer', 'stack', 'agent', 'agents', 'tool', 'tools',
  'app', 'apps', 'hub', 'os', 'wiki', 'crm', 'erp', 'cdp', 'cms', 'ide', 'api', 'sdk',
];

const NOUN_RE = new RegExp(
  `\\b(${CATEGORY_NOUNS.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

/** Words that must not be pulled in as modifiers -- they end the noun phrase. */
const MODIFIER_STOP = new Set([
  'the', 'a', 'an', 'your', 'our', 'their', 'its', 'my', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'be', 'been', 'and', 'or', 'but', 'with', 'without', 'from', 'to',
  'of', 'in', 'on', 'at', 'by', 'for', 'as', 'into', 'onto', 'we', 'you', 'they', 'it',
  'build', 'built', 'meet', 'introducing', 'welcome', 'get', 'try', 'use', 'using',
]);

const MODIFIER_WORD = /^[A-Za-z][A-Za-z0-9+&/.-]*$/;

/**
 * Nouns weak enough that, standing alone with no modifier and no "for X"
 * object, they say nothing about positioning. "Where teams and agents think
 * together" should not yield the category "agents".
 */
const WEAK_STANDALONE = new Set([
  'agent', 'agents', 'tool', 'tools', 'app', 'apps', 'software', 'solution',
  'service', 'system', 'suite', 'engine', 'layer', 'stack', 'hub', 'network',
  'framework', 'builder', 'editor', 'inbox', 'api', 'sdk', 'os', 'automation',
]);

/**
 * Pull "<up to 3 modifiers> <category noun> [for <object>]" out of one string.
 *
 * Returns a structured result so the caller can score competing candidates.
 * Exported for direct unit testing -- this is the fiddliest heuristic we have.
 */
export function categoryFromText(input) {
  const s = collapse(input ?? '');
  if (!s || s.length > 400) return null;

  const m = NOUN_RE.exec(s);
  if (!m) return null;

  const noun = m[1];
  const before = s.slice(0, m.index);

  // Walk backwards over at most three modifier words.
  const prevWords = before.split(/[\s]+/).filter(Boolean);
  const modifiers = [];
  for (let i = prevWords.length - 1; i >= 0 && modifiers.length < 3; i--) {
    const w = prevWords[i];
    // A clause boundary ends the phrase.
    if (/[.,;:!?"'()—–]$/.test(w)) break;
    const bare = w.replace(/^[^A-Za-z0-9]+/, '');
    if (!MODIFIER_WORD.test(bare)) break;
    if (MODIFIER_STOP.has(bare.toLowerCase())) break;
    modifiers.unshift(bare);
  }

  // "... for <object>" is part of the category claim, not decoration.
  let object = '';
  const after = s.slice(m.index + noun.length);
  const forMatch = /^\s+for\s+((?:[A-Za-z0-9][\w+&/.'-]*)(?:\s+(?:[A-Za-z0-9][\w+&/.'-]*)){0,4})/i.exec(after);
  if (forMatch) {
    object = ` for ${forMatch[1]}`;
  }

  const phrase = collapse(`${modifiers.join(' ')} ${noun}${object}`)
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '');

  if (phrase.length < 3 || phrase.length > 70) return null;
  // A naked two-letter noun ("os", "ai") with no modifier and no object is noise.
  if (phrase.length <= 3 && !object) return null;
  // "agents" on its own is a word in a sentence, not a category claim.
  if (modifiers.length === 0 && !object && WEAK_STANDALONE.has(noun.toLowerCase())) return null;

  return { phrase, noun: noun.toLowerCase(), modifiers, object: object ? object.trim() : null };
}

/**
 * schema.org's `applicationCategory` vocabulary ("BusinessApplication",
 * "DeveloperApplication", "WebApplication") is a fixed taxonomy chosen for
 * search engines. It never changes when positioning changes, so treating it as
 * a category label would silently flatten the most interesting signal we have.
 * Only free-text values are accepted.
 */
function isSchemaOrgEnum(v) {
  const compact = v.replace(/\s+/g, '');
  return /application$/i.test(compact) || /^other$/i.test(compact);
}

/**
 * Category label.
 *
 * Rather than taking the first source that yields anything, every source is
 * turned into a candidate and scored. A rich phrase from a weaker source (the
 * meta title's "AI workspace") beats a bare noun scraped out of the <h1>
 * ("agents"), which is the right answer for how these pages are actually
 * written.
 */
export function extractCategory(doc, raw, { headline, metaTitle, metaDescription, subhead } = {}) {
  const candidates = [];

  for (const node of jsonLd(raw)) {
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeof t === 'string' && /SoftwareApplication|WebApplication|Product/i.test(t))) continue;
    const cat = node.applicationCategory ?? node.applicationSubCategory ?? node.category;
    const v = clean(typeof cat === 'string' ? cat : null, 70);
    if (v && /[a-z]/i.test(v) && !isSchemaOrgEnum(v)) {
      candidates.push({ phrase: v.toLowerCase(), method: 'json-ld:applicationCategory', base: 0.95, bonus: 0.3 });
    }
  }

  const sources = [
    ['h1', headline?.value, 0.85],
    ['meta-title', metaTitle?.value, 0.7],
    ['subhead', subhead?.value, 0.6],
    ['meta-description', metaDescription?.value, 0.5],
  ];
  for (const [method, value, base] of sources) {
    if (!value) continue;
    const parsed = categoryFromText(value);
    if (!parsed) continue;
    // A phrase with modifiers and an object is a real category claim.
    const bonus = Math.min(parsed.modifiers.length, 2) * 0.12 + (parsed.object ? 0.2 : 0);
    candidates.push({ phrase: parsed.phrase, method: `pattern:${method}`, base, bonus });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.base + b.bonus) - (a.base + a.bonus));
  const best = candidates[0];
  return ok(best.phrase, best.method, Math.round(Math.min(0.99, best.base) * 100) / 100);
}
