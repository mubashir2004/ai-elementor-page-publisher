/**
 * ============================================================
 * FILE: backend/historyStore.js
 *
 * Small JSON-file version store for generation history & rollback.
 * One file per (site, page):
 *   data/history/<siteKey>/<pageId>.json  ->  { versions: [entry, ...] }
 *
 * An entry is:
 *   { versionId, ts, source: 'generate'|'refine'|'backup',
 *     title, summary, pageJson }
 *
 * Only the LAST 20 versions are kept. All reads tolerate missing or
 * corrupt files (they behave like an empty history).
 *
 * The root directory can be overridden with EAI_HISTORY_DIR (used by
 * tests to point the store at a temp dir).
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VERSIONS = 20;

/** Root dir for all history files (env override for tests). */
function historyRoot() {
  return process.env.EAI_HISTORY_DIR || path.join(__dirname, 'data', 'history');
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

/** Sanitize a pageId into a safe file name fragment. */
function safePageId(pageId) {
  const pid = String(pageId == null ? '' : pageId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!pid) {
    const e = new Error('Invalid pageId for history store.');
    e.status = 400;
    e.code = 'bad_page_id';
    throw e;
  }
  return pid;
}

function fileFor(creds, pageId) {
  return path.join(historyRoot(), siteKey(creds), `${safePageId(pageId)}.json`);
}

/** Read the raw versions array; missing/corrupt files -> []. */
async function readVersions(creds, pageId) {
  const file = fileFor(creds, pageId);
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (_) {
    return []; // missing file / unreadable — empty history
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isEntryLike);
    if (parsed && Array.isArray(parsed.versions)) return parsed.versions.filter(isEntryLike);
    return [];
  } catch (_) {
    return []; // corrupt file — treat as empty
  }
}

function isEntryLike(v) {
  return v && typeof v === 'object';
}

function randomVersionId() {
  return crypto.randomBytes(4).toString('hex'); // 8 chars
}

/**
 * Append a version entry, keeping only the last MAX_VERSIONS.
 * Fills in versionId/ts when the caller did not provide them.
 * Returns the stored entry.
 */
async function appendVersion(creds, pageId, entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const stored = {
    versionId: typeof e.versionId === 'string' && e.versionId ? e.versionId : randomVersionId(),
    ts: typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString(),
    source: e.source === 'refine' || e.source === 'backup' ? e.source : 'generate',
    title: typeof e.title === 'string' ? e.title : '',
    summary: typeof e.summary === 'string' ? e.summary : '',
    pageJson: e.pageJson,
  };

  const versions = await readVersions(creds, pageId);
  versions.push(stored);
  const trimmed = versions.slice(-MAX_VERSIONS);

  const file = fileFor(creds, pageId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ versions: trimmed }), 'utf8');
  return stored;
}

/**
 * List versions for a page WITHOUT the (large) pageJson payloads.
 * Newest first.
 */
async function listVersions(creds, pageId) {
  const versions = await readVersions(creds, pageId);
  return versions
    .map(({ pageJson, ...meta }) => meta)
    .reverse();
}

/** Fetch one full version (including pageJson) by versionId, or null. */
async function getVersion(creds, pageId, versionId) {
  if (!versionId) return null;
  const versions = await readVersions(creds, pageId);
  return versions.find((v) => v.versionId === String(versionId)) || null;
}

module.exports = { appendVersion, listVersions, getVersion, MAX_VERSIONS };
