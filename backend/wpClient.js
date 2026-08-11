/**
 * ============================================================
 * FILE: backend/wpClient.js
 * OWNER: Person 2 (Backend Core & WordPress Client)
 *
 * Thin wrapper around fetch for the eai/v1 plugin routes plus
 * a couple of core WP REST checks. All calls are server-side.
 *
 * A "creds" object everywhere is:
 *   { wpUrl, wpUser, wpAppPassword }
 * ============================================================
 */

'use strict';

/** Build the Basic auth header WordPress expects for App Passwords. */
function authHeader(creds) {
  const token = Buffer.from(`${creds.wpUser}:${creds.wpAppPassword}`).toString('base64');
  return `Basic ${token}`;
}

/** Normalize the site URL (strip trailing slash, force https). */
function normalizeSite(wpUrl) {
  let u = (wpUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(u)) {
    throw httpError(400, 'insecure_url', 'WordPress URL must start with https://');
  }
  return u;
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Core fetch with timeout + normalized errors. */
async function call(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(t);
    if (err.name === 'AbortError') throw httpError(504, 'timeout', 'WordPress request timed out.');
    throw httpError(502, 'network', `Could not reach WordPress: ${err.message}`);
  }
  clearTimeout(t);

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }

  if (!res.ok) {
    // Map common failures to friendly codes.
    if (res.status === 401 || res.status === 403) {
      throw httpError(res.status, 'bad_credentials', 'WordPress rejected the username / application password.');
    }
    if (res.status === 404 && url.includes('/wp-json/eai/')) {
      throw httpError(404, 'plugin_missing', 'EAI Connector plugin not found on the site. Install & activate it.');
    }
    const msg = (json && (json.message || json.code)) || `WordPress returned ${res.status}.`;
    throw httpError(res.status, 'wp_error', msg);
  }
  return json;
}

/** GET {site}/wp-json — confirms this is a WP REST site (no auth). */
async function coreCheck(creds) {
  const site = normalizeSite(creds.wpUrl);
  await call(`${site}/wp-json`, {}, 15000);
  return true;
}

/** Authenticated identity check. */
async function authCheck(creds) {
  const site = normalizeSite(creds.wpUrl);
  const me = await call(`${site}/wp-json/wp/v2/users/me?context=edit`, {
    headers: { Authorization: authHeader(creds) },
  });
  return me;
}

async function ping(creds) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/ping`, {
    headers: { Authorization: authHeader(creds) },
  });
}

async function listPages(creds) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/pages`, {
    headers: { Authorization: authHeader(creds) },
  });
}

async function getPage(creds, id) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/pages/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader(creds) },
  });
}

/**
 * GET {site}/wp-json/eai/v1/globals — the site's Elementor global colors
 * and typography (active kit). Older plugin versions do not have this
 * route; call() surfaces that as a 404 "plugin_missing" error which the
 * server maps to { available: false }.
 */
async function getGlobals(creds) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/globals`, {
    headers: { Authorization: authHeader(creds) },
  });
}

async function savePage(creds, payload) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/pages`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, 30000);
}

/** List the site's Elementor Pro GLOBAL WIDGETS (plugin v1.3.0+). */
async function getGlobalWidgets(creds) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/globals/widgets`, {
    headers: { Authorization: authHeader(creds) },
  });
}

/** Create a GLOBAL WIDGET from a single widget element (plugin v1.3.0+). */
async function createGlobalWidget(creds, payload) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/globals/widgets`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, 30000);
}

async function sideloadMedia(creds, url) {
  // Primary path: download the bytes HERE and upload via core /wp/v2/media.
  // The plugin's media_sideload_image() rejects extension-less stock URLs
  // (images.unsplash.com/photo-XXXX?w=1400 has no .jpg in the path), which
  // silently left every image external instead of in the Media Library.
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 25000);
    let res;
    try {
      res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
    if (res && res.ok) {
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (/^image\//.test(mime)) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 500) {
          const ext = ({
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
            'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
          })[mime] || 'jpg';
          const filename = 'eai-' + Math.random().toString(36).slice(2, 10) + '.' + ext;
          return await uploadMedia(creds, buffer, filename, mime);
        }
      }
    }
  } catch (_) {
    // fall through to the plugin endpoint
  }
  // Fallback: the plugin's server-side sideload (works for URLs with a
  // real file extension, or when this backend cannot reach the image host).
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/media/sideload`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  }, 30000);
}

/**
 * Upload raw image bytes straight to the WordPress core media library.
 * Unlike call(), the body here is a raw Buffer (must NOT be JSON.stringify'd),
 * so this uses its own fetch with the same 30s timeout + error mapping.
 * Returns { id, url } where url is the attachment's source_url.
 */
async function uploadMedia(creds, buffer, filename, mime) {
  const site = normalizeSite(creds.wpUrl);
  const endpoint = `${site}/wp-json/wp/v2/media`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authHeader(creds),
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: buffer, // raw bytes — sent untouched
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (err.name === 'AbortError') throw httpError(504, 'timeout', 'WordPress media upload timed out.');
    throw httpError(502, 'network', `Could not reach WordPress: ${err.message}`);
  }
  clearTimeout(t);

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw httpError(res.status, 'bad_credentials', 'WordPress rejected the username / application password.');
    }
    const msg = (json && (json.message || json.code)) || `WordPress returned ${res.status}.`;
    throw httpError(res.status, 'wp_error', msg);
  }

  return { id: json.id, url: json.source_url };
}

/**
 * Full connection test used by /api/connect/test.
 * Reports each check independently (does not fail fast).
 */
async function connectionTest(creds) {
  const result = {
    wpReachable: false,
    authValid: false,
    pluginInstalled: false,
    elementorActive: false,
    elementorPro: false,
    wpVersion: null,
    elementorVersion: null,
    messages: {},
  };

  try {
    await coreCheck(creds);
    result.wpReachable = true;
  } catch (e) {
    result.messages.wpReachable = e.message;
    return result; // nothing else will work
  }

  try {
    await authCheck(creds);
    result.authValid = true;
  } catch (e) {
    result.messages.authValid = e.message;
  }

  try {
    const p = await ping(creds);
    result.pluginInstalled = !!p.ok;
    result.elementorActive = !!p.elementor_active;
    result.elementorPro = !!p.elementor_pro;
    result.wpVersion = p.wp_version || null;
    result.elementorVersion = p.elementor_version || null;
    if (!result.elementorActive) {
      result.messages.elementorActive = 'Elementor is not active on this site.';
    }
  } catch (e) {
    result.messages.pluginInstalled = e.message;
  }

  return result;
}

/** Create an Elementor library template (plugin v1.4.0+; e.g. a loop-item card). */
async function createTemplate(creds, payload) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/templates`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, 30000);
}

/** Create/refresh a WordPress menu with given items (plugin v1.5.0+). */
async function createMenu(creds, payload) {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/menus`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, 30000);
}

/** List Elementor library templates of a type (plugin v1.4.0+). */
async function listTemplates(creds, type = 'loop-item') {
  const site = normalizeSite(creds.wpUrl);
  return call(`${site}/wp-json/eai/v1/templates?type=${encodeURIComponent(type)}`, {
    headers: { Authorization: authHeader(creds) },
  });
}

module.exports = {
  coreCheck, authCheck, ping, listPages, getPage, savePage, getGlobals,
  sideloadMedia, uploadMedia, connectionTest, normalizeSite, authHeader,
  getGlobalWidgets, createGlobalWidget, createTemplate, listTemplates, createMenu,
};
