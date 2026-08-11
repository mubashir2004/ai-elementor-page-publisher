/**
 * ============================================================
 * FILE: backend/componentStore.js
 *
 * Component library — small JSON-file store for reusable blocks
 * ("save this hero / pricing section and reuse it on the next page").
 * One file per site:
 *   data/components/<siteKey>.json  ->  { components: [entry, ...] }
 *
 * An entry is:
 *   { id, name, type, createdAt, element }
 * where `element` is a full Elementor element object (container /
 * section / widget subtree) exactly as it appears in page JSON.
 *
 * Only the newest MAX_COMPONENTS are kept. All reads tolerate
 * missing or corrupt files (they behave like an empty library).
 *
 * The data root defaults to backend/data and can be overridden with
 * EAI_DATA_DIR (used by tests to point the store at a temp dir).
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_COMPONENTS = 100;

/** Root dir for all component files (env override for tests). */
function componentsRoot() {
  const dataRoot = process.env.EAI_DATA_DIR || path.join(__dirname, 'data');
  return path.join(dataRoot, 'components');
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
  return path.join(componentsRoot(), `${siteKey(creds)}.json`);
}

/** Short random id: 7 chars, [a-z0-9] — same shape Elementor uses. */
function shortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(7);
  let out = '';
  for (let i = 0; i < 7; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** Read the raw component array; missing/corrupt files -> []. */
async function readAll(creds) {
  let text;
  try {
    text = await fs.promises.readFile(fileFor(creds), 'utf8');
  } catch (_) {
    return []; // missing file / unreadable — empty library
  }
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.components) ? parsed.components : []);
    return list.filter(isEntryLike);
  } catch (_) {
    return []; // corrupt file — treat as empty
  }
}

function isEntryLike(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && c.id;
}

async function writeAll(creds, components) {
  const file = fileFor(creds);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ components }), 'utf8');
}

/** List saved components WITHOUT the (large) element payloads. */
async function listComponents(creds) {
  const all = await readAll(creds);
  return all.map(({ id, name, type, createdAt }) => ({ id, name, type, createdAt }));
}

/**
 * Fetch full entries (including element) for the given ids, in the
 * order requested. Unknown ids are silently skipped.
 */
async function getComponents(creds, ids) {
  const wanted = Array.isArray(ids) ? ids.map(String) : [];
  if (wanted.length === 0) return [];
  const all = await readAll(creds);
  const byId = new Map(all.map((c) => [c.id, c]));
  return wanted.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Save a component. `element` must be a plausible Elementor element
 * (an object with an elType string). Returns { id }.
 * The store keeps only the newest MAX_COMPONENTS entries.
 */
async function saveComponent(creds, { name, type, element } = {}) {
  if (!element || typeof element !== 'object' || Array.isArray(element) ||
      typeof element.elType !== 'string' || !element.elType) {
    const e = new Error('element must be an Elementor element object with an elType.');
    e.status = 400;
    e.code = 'bad_element';
    throw e;
  }

  const all = await readAll(creds);
  const usedIds = new Set(all.map((c) => c.id));
  let id = shortId();
  while (usedIds.has(id)) id = shortId();

  const entry = {
    id,
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'Untitled block',
    type: typeof type === 'string' && type.trim()
      ? type.trim().slice(0, 40)
      : String(element.widgetType || element.elType),
    createdAt: new Date().toISOString(),
    element,
  };

  all.push(entry);
  await writeAll(creds, all.slice(-MAX_COMPONENTS));
  return { id: entry.id };
}

/** Delete a component by id. Returns true when something was removed. */
async function deleteComponent(creds, id) {
  const all = await readAll(creds);
  const next = all.filter((c) => c.id !== String(id));
  if (next.length === all.length) return false;
  await writeAll(creds, next);
  return true;
}

module.exports = {
  listComponents,
  getComponents,
  saveComponent,
  deleteComponent,
  MAX_COMPONENTS,
};
