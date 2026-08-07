/**
 * Where the crawl ran from.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On 2026-08-07 this index published two change events saying Notion had moved
 * its entry price from EUR 9.5 to USD 10 and reordered its pricing tiers. Notion
 * had done neither. The first observation was crawled from a laptop in Germany;
 * the second, seven minutes later, from a GitHub Actions runner in a US data
 * centre. `notion.com/pricing` geo-routes currency by client IP. Both pages
 * declared `<html lang="en">` and the same canonical URL, so the two gates that
 * exist for exactly this class of problem saw nothing wrong.
 *
 * The observation context had changed, not the page -- and the crawl origin was
 * recorded nowhere, so the archive could not tell the difference even in
 * hindsight. This module makes the origin a first-class fact on every
 * observation and every run, so src/diff.js can apply the rule the project
 * already applies to parser faults: WHEN THE OBSERVATION CONTEXT CHANGES, THAT
 * IS A CONTEXT FAULT, NOT DRIFT.
 *
 * HOW THE ORIGIN IS RESOLVED
 * --------------------------
 * Cheaply, without an account, and identically on a laptop and on a runner:
 *
 *   1. environment -- from the environment variables GitHub Actions sets. This
 *      is free, exact, and never fails. `local` or `github-actions`.
 *   2. country/region -- one HTTP request per run to a Cloudflare edge trace
 *      endpoint, which reports the country the request egressed from in a two
 *      line plain-text body. No key, no quota, no account, no personal data
 *      sent, and it answers the same question in CI and at home.
 *
 * Everything about step 2 is best-effort. It has a short timeout of its own, it
 * never throws, and a failure yields `country: null` -- which reads as
 * `unknown` everywhere downstream. UNKNOWN IS AN ACCEPTABLE VALUE. SILENTLY
 * WRONG IS NOT: we never infer a country from a system timezone or a locale,
 * because a laptop configured in one place and connected through another would
 * then produce a confident lie, which is worse than the gap it filled.
 *
 * The probe is also skippable (`POSITIONING_ORIGIN_PROBE=off`) and overridable
 * (`POSITIONING_ORIGIN_COUNTRY=DE`), so tests, dry runs and offline work never
 * touch the network for it.
 */

import { crawlHeaders } from './agent.js';

/** Where the origin probe asks "which country did this request come from?". */
export const ORIGIN_PROBE_URL = 'https://cloudflare.com/cdn-cgi/trace';

/** The probe must never hold up a crawl. Shorter than the page timeout on purpose. */
export const ORIGIN_PROBE_TIMEOUT_MS = 4_000;

/**
 * The origin of an observation we have no origin for.
 *
 * Every observation recorded before 2026-08-07 is one of these. It is not the
 * same thing as "the same origin as now", and originsDiffer() below is careful
 * to say `indeterminate` rather than guess in either direction.
 */
export const UNKNOWN_ORIGIN = Object.freeze({
  environment: 'unknown',
  country: null,
  region: null,
  method: 'not-recorded',
  id: 'unknown',
});

/**
 * `local` or `github-actions`, from the environment alone.
 *
 * GITHUB_ACTIONS is set to the string "true" on every runner; RUNNER_OS and
 * RUNNER_ENVIRONMENT are checked as a fallback so a workflow that unsets the
 * first is still identified rather than mislabelled `local`.
 */
export function environmentOf(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true' || env.RUNNER_ENVIRONMENT || env.RUNNER_OS) return 'github-actions';
  return 'local';
}

/** The comparison key. Two observations share an origin when these are equal. */
export function originId({ environment, country }) {
  return `${environment ?? 'unknown'}:${country ?? 'unknown'}`;
}

/** Parse the `key=value` lines of a Cloudflare trace body. `loc` is an ISO 3166-1 alpha-2 code. */
export function parseTrace(body) {
  const out = {};
  for (const line of String(body ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const country = /^[A-Z]{2}$/.test(out.loc ?? '') ? out.loc : null;
  const region = /^[A-Z]{3}$/.test(out.colo ?? '') ? out.colo : null;
  return { country, region };
}

/**
 * Resolve the origin of this run. Never throws, never blocks the crawl.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]        environment variables
 * @param {function} [opts.fetchImpl]
 * @param {boolean} [opts.probe]     set false to skip the network entirely
 * @returns {Promise<{environment: string, country: string|null, region: string|null, method: string, id: string}>}
 */
export async function resolveOrigin({ env = process.env, fetchImpl = fetch, probe = true } = {}) {
  const environment = environmentOf(env);

  const settle = (country, region, method) =>
    ({ environment, country, region, method, id: originId({ environment, country }) });

  // An explicit override wins, so a run can be made reproducible offline and a
  // test never has to reach the network to exercise the origin rules.
  const forced = (env.POSITIONING_ORIGIN_COUNTRY ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(forced)) return settle(forced, null, 'env-override');

  if (!probe || env.POSITIONING_ORIGIN_PROBE === 'off') return settle(null, null, 'probe-disabled');

  try {
    const res = await fetchImpl(ORIGIN_PROBE_URL, {
      headers: crawlHeaders({ accept: 'text/plain' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(ORIGIN_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return settle(null, null, `probe-http-${res.status}`);
    const { country, region } = parseTrace(await res.text());
    if (!country) return settle(null, region, 'probe-no-country');
    return settle(country, region, 'cdn-trace');
  } catch {
    // A crawl that cannot say where it ran from is still a crawl worth running.
    // It records `unknown`, and the diff engine treats `unknown` as "cannot
    // rule out a shift" rather than as "no shift".
    return settle(null, null, 'probe-failed');
  }
}

/**
 * Did the observation context move between two crawls?
 *
 * Three answers, and the third one is the point:
 *
 *   'same'           -- provably the same origin. Diff normally.
 *   'different'      -- provably a different origin. Locale-sensitive signals
 *                       are suppressed; see src/diff.js.
 *   'indeterminate'  -- one side does not know its country (an old observation,
 *                       or a probe that failed). We refuse to claim either way.
 *
 * `indeterminate` deliberately does NOT suppress on its own: doing so would
 * mute the index every time a probe timed out. The currency rule in src/diff.js
 * is what covers the indeterminate case, because it needs no origin at all.
 */
export function originsDiffer(before, after) {
  const a = before ?? UNKNOWN_ORIGIN;
  const b = after ?? UNKNOWN_ORIGIN;

  const envA = a.environment ?? 'unknown';
  const envB = b.environment ?? 'unknown';
  if (envA !== 'unknown' && envB !== 'unknown' && envA !== envB) return 'different';

  if (a.country && b.country) return a.country === b.country ? 'same' : 'different';

  // Same known environment, but at least one country is unknown.
  if (envA !== 'unknown' && envA === envB && !a.country && !b.country) return 'indeterminate';
  return 'indeterminate';
}

/** A short human-readable form for run output, reasons and the public page. */
export function describeOrigin(origin) {
  const o = origin ?? UNKNOWN_ORIGIN;
  const where = o.country ? `${o.country}${o.region ? `/${o.region}` : ''}` : 'country unknown';
  return `${o.environment ?? 'unknown'} (${where})`;
}
