/**
 * A fetch() stand-in driven by a route table.
 *
 * Routes map a URL to either a string body, or { status, body, headers }, or a
 * function receiving (url, init). Every call is recorded so tests can assert on
 * request headers and on how many requests were made to a host -- which is how
 * the politeness guarantees are tested rather than merely asserted in prose.
 */
export function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const route = routes[String(url)];
    if (route === undefined) return new Response('not found', { status: 404 });
    const resolved = typeof route === 'function' ? await route(String(url), init) : route;
    if (resolved instanceof Response) return resolved;
    if (typeof resolved === 'string') {
      return new Response(resolved, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(resolved.body ?? '', {
      status: resolved.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(resolved.headers ?? {}) },
    });
  };
  impl.calls = calls;
  impl.callsTo = (host) => calls.filter((c) => new URL(c.url).hostname === host);
  return impl;
}
