/**
 * ============================================================
 * FILE: backend/brandStore.js
 *
 * Brand manager — small JSON-file store for saved brands.
 * One file per site:
 *   data/brands/<siteKey>.json  ->  { brands: [entry, ...] }
 *
 * An entry is:
 *   { id, name, createdAt, palette?, fonts?, context? }
 * where palette/fonts are flat string maps (same shape as the
 * preset brand kits in brandKits.js, e.g. palette.bg, fonts.heading)
 * and `context` is freeform brand/guardrail text appended to the
 * generation's brandContext.
 *
 * Only the newest MAX_BRANDS are kept. All reads tolerate missing
 * or corrupt files (they behave like an empty list).
 *
 * The data root defaults to backend/data and can be overridden with
 * EAI_DATA_DIR (used by tests to point the store at a temp dir).
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BRANDS = 100;
const MAX_MAP_KEYS = 16;      // palette/fonts entries kept per brand
const MAX_CONTEXT_CHARS = 4000;

/** Root dir for all brand files (env override for tests). */
function brandsRoot() {
  const dataRoot = process.env.EAI_DATA_DIR || path.join(__dirname, 'data');
  return path.join(dataRoot, 'brands');
}

/** Derive a filesystem-safe site key from creds.wpUrl ([a-z0-9.-] only). */
function siteKey(creds) {
  const raw = creds && creds.wpUrl ? String(creds.wpUrl) : '';
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch (_) {
    // No/invalid protocol — strip scheme/userinfo/port/path by hand.
    host = raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[/?#]/)[0]
      .split('@')
      .pop()
      .split(':')[0];
  }
  const key = String(host || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return key || 'unknown-site';
}

function fileFor(creds) {
  return path.join(brandsRoot(), `${siteKey(creds)}.json`);
}

/** Short random id: 7 chars, [a-z0-9]. */
function shortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(7);
  let out = '';
  for (let i = 0; i < 7; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** Keep only own string-valued entries of a flat map; cap size. Null when empty. */
function sanitizeStringMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const out = {};
  let kept = 0;
  for (const key of Object.keys(map)) {
    if (kept >= MAX_MAP_KEYS) break;
    const value = map[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    out[String(key).slice(0, 40)] = value.trim().slice(0, 120);
    kept++;
  }
  return kept > 0 ? out : null;
}

/** Read the raw brands array; missing/corrupt files -> []. */
async function readAll(creds) {
  let text;
  try {
    text = await fs.promises.readFile(fileFor(creds), 'utf8');
  } catch (_) {
    return []; // missing file / unreadable — empty list
  }
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.brands) ? parsed.brands : []);
    return list.filter(isEntryLike);
  } catch (_) {
    return []; // corrupt file — treat as empty
  }
}

function isEntryLike(b) {
  return b && typeof b === 'object' && typeof b.id === 'string' && b.id;
}

async function writeAll(creds, brands) {
  const file = fileFor(creds);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ brands }), 'utf8');
}

/**
 * Shared-scope pseudo-site: brands saved with scope "all" live in
 * data/brands/shared.json and appear on EVERY site the user connects
 * (multi-brand support for agencies managing multiple client sites).
 */
const SHARED_CREDS = { wpUrl: 'https://shared' };

/** List saved brands: this site's + the shared (all-sites) ones. */
async function listBrands(creds) {
  const site = (await readAll(creds)).map((b) => ({ scope: 'site', ...b, revisions: revCount(b) }));
  const shared = (await readAll(SHARED_CREDS)).map((b) => ({ ...b, scope: 'all', revisions: revCount(b) }));
  return [...site.filter((b) => b.scope !== 'all'), ...shared];
}

function revCount(b) {
  return Array.isArray(b && b._revisions) ? b._revisions.length : 0;
}

/** Fetch one brand by id — checks this site's store, then the shared one. */
async function getBrand(creds, id) {
  if (!id) return null;
  const site = await readAll(creds);
  const found = site.find((b) => b.id === String(id));
  if (found) return found;
  const shared = await readAll(SHARED_CREDS);
  return shared.find((b) => b.id === String(id)) || null;
}

/**
 * Update a brand in place (version-controlled): the previous state is
 * pushed onto the entry's _revisions (newest first, capped at 10) before
 * the patch is applied. A scope change moves the entry between the
 * site store and the shared store. Returns true when found+updated.
 */
async function updateBrand(creds, id, patch = {}) {
  const stores = [
    { creds, list: await readAll(creds) },
    { creds: SHARED_CREDS, list: await readAll(SHARED_CREDS) },
  ];
  for (const store of stores) {
    const idx = store.list.findIndex((b) => b.id === String(id));
    if (idx === -1) continue;
    const entry = store.list[idx];

    // Version-control: snapshot the current state before changing it.
    const prev = { ts: new Date().toISOString(), name: entry.name };
    if (entry.palette) prev.palette = entry.palette;
    if (entry.fonts) prev.fonts = entry.fonts;
    if (entry.context) prev.context = entry.context;
    entry._revisions = [prev, ...(Array.isArray(entry._revisions) ? entry._revisions : [])].slice(0, 10);

    if (typeof patch.name === 'string' && patch.name.trim()) {
      entry.name = patch.name.trim().slice(0, 80);
    }
    const cleanPalette = sanitizeStringMap(patch.palette);
    if (cleanPalette) entry.palette = cleanPalette;
    const cleanFonts = sanitizeStringMap(patch.fonts);
    if (cleanFonts) entry.fonts = cleanFonts;
    if (typeof patch.context === 'string' && patch.context.trim()) {
      entry.context = patch.context.trim().slice(0, MAX_CONTEXT_CHARS);
    }

    const wantShared = patch.scope === 'all';
    const isShared = store.creds === SHARED_CREDS;
    if (patch.scope && wantShared !== isShared) {
      // Move between stores on scope change.
      store.list.splice(idx, 1);
      await writeAll(store.creds, store.list);
      const target = wantShared ? SHARED_CREDS : creds;
      const targetList = await readAll(target);
      targetList.push(entry);
      await writeAll(target, targetList.slice(-MAX_BRANDS));
    } else {
      await writeAll(store.creds, store.list);
    }
    return true;
  }
  return false;
}

/**
 * Save a brand: { name (required), palette?, fonts?, context? }.
 * Returns { id }. The store keeps only the newest MAX_BRANDS.
 */
async function saveBrand(creds, { name, palette, fonts, context, scope } = {}) {
  // Shared brands live in the cross-site store.
  if (scope === 'all') creds = SHARED_CREDS;
  if (typeof name !== 'string' || !name.trim()) {
    const e = new Error('name is required.');
    e.status = 400;
    e.code = 'missing_name';
    throw e;
  }

  const all = await readAll(creds);
  const usedIds = new Set(all.map((b) => b.id));
  let id = shortId();
  while (usedIds.has(id)) id = shortId();

  const entry = {
    id,
    name: name.trim().slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  const cleanPalette = sanitizeStringMap(palette);
  if (cleanPalette) entry.palette = cleanPalette;
  const cleanFonts = sanitizeStringMap(fonts);
  if (cleanFonts) entry.fonts = cleanFonts;
  if (typeof context === 'string' && context.trim()) {
    entry.context = context.trim().slice(0, MAX_CONTEXT_CHARS);
  }

  all.push(entry);
  await writeAll(creds, all.slice(-MAX_BRANDS));
  return { id: entry.id };
}

/** Delete a brand by id. Returns true when something was removed. */
async function deleteBrand(creds, id) {
  for (const target of [creds, SHARED_CREDS]) {
    const all = await readAll(target);
    const next = all.filter((b) => b.id !== String(id));
    if (next.length !== all.length) {
      await writeAll(target, next);
      return true;
    }
  }
  return false;
}

module.exports = {
  listBrands,
  getBrand,
  saveBrand,
  updateBrand,
  deleteBrand,
  MAX_BRANDS,
};
