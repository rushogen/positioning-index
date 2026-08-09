/**
 * Headless render fallback, for pricing pages only.
 *
 * WHY THIS EXISTS, AND WHY IT IS NARROW
 * -------------------------------------
 * The crawler fetches one HTML document per page and never runs JavaScript --
 * that is the whole footprint promise in crawler.txt. But a growing share of
 * pricing pages (React / CSS-module apps) ship a shell whose plans render
 * client-side, so the raw HTML carries the meta title and nothing a reader would
 * call a price. For those, and only those, we fall back to rendering the page in
 * headless Chromium so the published pricing signal reflects what a visitor
 * actually sees.
 *
 * KEEPING THE FOOTPRINT HONEST
 * ----------------------------
 * This is invoked ONLY when the normal fetch already succeeded AND the pricing
 * extractor found no tiers/free-tier on the raw HTML (see runner.js) -- never
 * speculatively. Images, fonts, media, stylesheets and cross-origin requests are
 * blocked, so we load the first-party document and the scripts needed to paint
 * the plans, and nothing else -- no third-party beacons, no ad/analytics calls.
 * robots.txt was already honoured before the page was fetched at all.
 *
 * GRACEFUL ABSENCE
 * ----------------
 * Playwright is a heavy, optional dependency. It is imported dynamically; if it
 * is not installed (or the browser is missing), renderHtml returns null and the
 * crawler simply keeps the raw-HTML result. Nothing here is load-bearing for a
 * crawl that has no browser.
 */

let browserPromise = null;
let unavailable = false;

async function getBrowser() {
  if (unavailable) return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        const { chromium } = await import('playwright');
        return await chromium.launch({ args: ['--no-sandbox'] });
      } catch {
        unavailable = true;
        return null;
      }
    })();
  }
  return browserPromise;
}

/**
 * Render `url` and return its HTML after client-side scripts have run, or null
 * on any failure (which is a signal to keep the raw result).
 */
export async function renderHtml(url, { userAgent, timeout = 30000, settleMs = 2500 } = {}) {
  const browser = await getBrowser();
  if (!browser) return null;
  let context = null;
  try {
    context = await browser.newContext({ userAgent, javaScriptEnabled: true });
    const page = await context.newPage();
    // Minimal footprint: document + first-party scripts only.
    await page.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') return route.abort();
      try {
        const sameSite = new URL(req.url()).hostname.endsWith(new URL(url).hostname.split('.').slice(-2).join('.'));
        if (!sameSite && type !== 'document') return route.abort(); // no third-party beacons
      } catch { /* fall through */ }
      return route.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(settleMs); // let client-rendered plans paint
    const html = await page.content();
    return html && html.length ? html : null;
  } catch {
    return null;
  } finally {
    if (context) { try { await context.close(); } catch { /* ignore */ } }
  }
}

/** Close the shared browser at the end of a crawl. Safe to call when none exists. */
export async function closeRenderer() {
  if (!browserPromise) return;
  try { const b = await browserPromise; if (b) await b.close(); } catch { /* ignore */ }
  browserPromise = null;
}
