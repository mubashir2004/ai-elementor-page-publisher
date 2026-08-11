/**
 * ============================================================
 * FILE: backend/unsplashClient.js
 * OWNER: Person 4 (orchestrator)
 *
 * Thin, defensive wrapper over the Unsplash Search API used to
 * resolve real photo URLs for generated pages. Server-side only.
 *
 *   searchImage(query, accessKey) -> { url, alt } | null
 *
 * Never throws: any error, empty result, or missing key -> null.
 * ============================================================
 */

'use strict';

const ENDPOINT = 'https://api.unsplash.com/search/photos';
const TIMEOUT_MS = 8000;

/**
 * Fetch a single landscape photo for the given query.
 *
 * @param {string} query      free-text search terms
 * @param {string} accessKey  Unsplash Access Key ('' if none)
 * @param {Object} [opts]     { width } — desired pixel width. Section
 *                            backgrounds (heroes) need ~1920; inline
 *                            images are fine at the default 1080.
 * @returns {Promise<{url:string, alt:string}|null>}
 */
async function searchImage(query, accessKey, opts = {}) {
  const q = String(query || '').trim();
  const key = String(accessKey || '').trim();
  if (!q || !key) return null;

  const url =
    `${ENDPOINT}?query=${encodeURIComponent(q)}&per_page=1&orientation=landscape`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Client-ID ' + key },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;

    const data = await res.json();
    const results = data && Array.isArray(data.results) ? data.results : [];
    const first = results[0];
    if (!first || !first.urls || !first.urls.regular) return null;

    // urls.regular is capped at 1080px — too small for a full-bleed hero
    // background. When a wider size is requested, build it from urls.raw.
    const width = Number(opts.width) || 0;
    let photoUrl = first.urls.regular;
    if (width > 1080 && typeof first.urls.raw === 'string' && first.urls.raw) {
      const sep = first.urls.raw.includes('?') ? '&' : '?';
      photoUrl = `${first.urls.raw}${sep}w=${width}&q=80&auto=format&fit=crop`;
    }

    return {
      url: photoUrl,
      alt: first.alt_description || q,
    };
  } catch (_) {
    // Aborts, network errors, bad JSON — all swallowed by contract.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { searchImage };
