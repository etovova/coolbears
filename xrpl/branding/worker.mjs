import css from './wordmark.css';
import icon from './icon.png';
import wordmark from './wordmark.png';

const stylesheet = '/xrpl/site.css';
const favicon = '/xrpl/brand-logo.png';
const preview = '/previous-logo';

function responseFor(request, body, headers, status = 200) {
  return new Response(request.method === 'HEAD' ? null : body, {status, headers});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, {status: 405, headers: {Allow: 'GET, HEAD'}});

    if (url.pathname === preview) {
      const page = await env.STOREFRONT.fetch(new URL('/', url).href);
      if (!page.ok) return page;
      const headers = new Headers(page.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      headers.set('Cache-Control', 'no-store');
      headers.delete('Content-Length');
      headers.delete('ETag');
      const html = (await page.text())
        .replace('href="' + stylesheet + '"', 'href="' + stylesheet + '?previous"')
        .replace('href="' + favicon + '"', 'href="' + favicon + '?previous"');
      return responseFor(request, html, headers);
    }

    if (url.pathname !== stylesheet && url.pathname !== favicon)
      return new Response(null, {status: 404});
    if (url.searchParams.has('previous')) return env.STOREFRONT.fetch(request);

    if (url.pathname === favicon) {
      const image = url.searchParams.has('wordmark') ? wordmark : icon;
      return responseFor(request, image, {'Content-Type': 'image/png',
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
    }

    const original = await env.STOREFRONT.fetch(new URL(stylesheet, url).href);
    if (!original.ok) return original;
    const headers = new Headers(original.headers);
    headers.delete('Content-Length');
    headers.delete('ETag');
    return responseFor(request, (await original.text()) + '\n' + css, headers);
  }
};
