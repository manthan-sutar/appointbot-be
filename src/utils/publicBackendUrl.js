/**
 * Public base URL for widget embeds and client-side fetch (never prefer localhost
 * when the request or platform env indicates a real deployed host).
 */

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/$/, '');
}

/**
 * @param {string | undefined} url
 */
export function isLocalhostUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return /^(localhost|127\.0\.0\.1)$/i.test(u.hostname) || u.hostname === '[::1]';
  } catch {
    return true;
  }
}

/**
 * Best-effort public URL from the incoming HTTP request (works behind Render/Heroku
 * when `trust proxy` is enabled).
 * @param {import('express').Request} req
 */
export function publicBackendUrlFromRequest(req) {
  if (!req?.get) return null;
  const rawProto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const proto = String(rawProto).split(',')[0].trim() || 'https';
  const rawHost = req.get('x-forwarded-host') || req.get('host');
  const host = rawHost ? String(rawHost).split(',')[0].trim() : '';
  if (!host) return null;
  return stripTrailingSlash(`${proto}://${host}`);
}

/**
 * Resolves the backend base URL to embed in widget script tags and `window.__APPOINTBOT_WIDGET__.baseUrl`.
 *
 * Priority: PUBLIC_BACKEND_URL / WIDGET_PUBLIC_URL → non-localhost BACKEND_URL →
 * RENDER_EXTERNAL_URL → non-localhost request URL → remaining env / request.
 *
 * @param {import('express').Request} [req]
 */
export function getPublicBackendUrlForWidget(req) {
  const pub = process.env.PUBLIC_BACKEND_URL || process.env.WIDGET_PUBLIC_URL;
  if (pub) return stripTrailingSlash(pub);

  const backend = process.env.BACKEND_URL;
  if (backend && !isLocalhostUrl(backend)) return stripTrailingSlash(backend);

  const render = process.env.RENDER_EXTERNAL_URL;
  if (render && !isLocalhostUrl(render)) return stripTrailingSlash(render);

  const fromReq = req ? publicBackendUrlFromRequest(req) : null;
  if (fromReq && !isLocalhostUrl(fromReq)) return fromReq;

  if (backend) return stripTrailingSlash(backend);
  if (fromReq) return fromReq;

  const port = process.env.PORT || 3000;
  return `http://127.0.0.1:${port}`;
}
