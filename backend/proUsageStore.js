/**
 * ============================================================
 * FILE: backend/proUsageStore.js
 *
 * Cross-run Pro-widget usage tracking — answers "is Pro worth it
 * on this site?". One JSON file per site:
 *   data/pro-usage/<siteKey>.json -> { entries: [{ts, pageId, used}] }
 * Every generation records an entry (used may be empty — the zero
 * runs are the denominator for usage percentages). Capped at the
 * newest 300 entries. Reads tolerate missing/corrupt files.
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { FREE_ALTERNATIVES } = require('./proReport');

const MAX_ENTRIES = 300;

function usageRoot() {
  const dataRoot = process.env.EAI_DATA_DIR || path.join(__dirname, 'data');
  return path.join(dataRoot, 'pro-usage');
}

/** Same site-key derivation as the other per-site stores. */
function siteKey(creds) {
  const raw = creds && creds.wpUrl ? String(creds.wpUrl) : '';
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch (_) {
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
  return path.join(usageRoot(), `${siteKey(creds)}.json`);
}

async function readEntries(creds) {
  let text;
  try {
    text = await fs.promises.readFile(fileFor(creds), 'utf8');
  } catch (_) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    const list = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    return list.filter((e) => e && typeof e === 'object' && e.ts);
  } catch (_) {
    return [];
  }
}

/** Record one generation's pro-widget usage (used: [{widget,count}]). */
async function recordUsage(creds, pageId, used) {
  const entries = await readEntries(creds);
  entries.push({
    ts: new Date().toISOString(),
    pageId: pageId != null ? pageId : null,
    used: Array.isArray(used)
      ? used.map((u) => ({ widget: String(u.widget), count: Number(u.count) || 1 }))
      : [],
  });
  const file = fileFor(creds);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) }),
    'utf8',
  );
}

/** Aggregate across all recorded runs for the site. */
async function aggregateUsage(creds) {
  const entries = await readEntries(creds);
  const byWidget = new Map();
  for (const e of entries) {
    for (const u of e.used || []) {
      const cur = byWidget.get(u.widget) || { widget: u.widget, totalCount: 0, runs: 0 };
      cur.totalCount += Number(u.count) || 1;
      cur.runs += 1;
      byWidget.set(u.widget, cur);
    }
  }
  const widgets = [...byWidget.values()]
    .sort((a, b) => b.runs - a.runs || b.totalCount - a.totalCount)
    .map((w) => ({ ...w, freeAlternative: FREE_ALTERNATIVES[w.widget] || '(no free equivalent)' }));
  return {
    runs: entries.length,
    since: entries.length ? entries[0].ts : null,
    widgets,
  };
}

module.exports = { recordUsage, aggregateUsage, MAX_ENTRIES };
