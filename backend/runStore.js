/**
 * ============================================================
 * FILE: backend/runStore.js
 *
 * Live-run registry so a dropped connection never costs a build.
 *
 * A page build runs 10-25 minutes on an SSE stream. Hosting proxies,
 * laptop sleep, wifi hiccups and tab reloads all break that stream — but
 * the pipeline keeps running server-side, publishes, and finishes. Before
 * this registry the browser simply lost sight of it and the user had to
 * start over, paying for the same work twice.
 *
 * Every run is recorded here by id: current stage, then its final result or
 * error. The client reattaches with GET /api/runs/:id and picks up exactly
 * where it was — mid-build it keeps showing progress, and if the build has
 * since finished it receives the finished page.
 *
 * Records live in memory AND on disk (EAI_DATA_DIR/runs), so a server
 * restart or a second browser tab can still recover a finished build.
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TTL_MS = 6 * 60 * 60 * 1000;   // keep finished runs recoverable for 6h
const SWEEP_MS = 30 * 60 * 1000;

const runs = new Map();

function runsDir() {
  const root = process.env.EAI_DATA_DIR || path.join(__dirname, 'data');
  return path.join(root, 'runs');
}

function fileFor(id) {
  return path.join(runsDir(), `${String(id).replace(/[^a-z0-9-]/gi, '')}.json`);
}

/** Persist best-effort: a write failure must never break a running build. */
function persist(rec) {
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.writeFileSync(fileFor(rec.id), JSON.stringify(rec));
  } catch (_) { /* memory copy still serves this process */ }
}

function newId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Start tracking a run. `meta` is small, user-visible context (kind, title). */
function start(meta = {}) {
  const rec = {
    id: newId(),
    status: 'running',
    stage: null,
    detail: '',
    result: null,
    error: null,
    meta,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  runs.set(rec.id, rec);
  persist(rec);
  return rec;
}

function update(id, stage, detail) {
  const rec = runs.get(id);
  if (!rec || rec.status !== 'running') return;
  rec.stage = stage;
  if (typeof detail === 'string') rec.detail = detail;
  rec.updatedAt = Date.now();
  // Stage changes are worth persisting; per-character detail updates are not.
  persist(rec);
}

function finish(id, result) {
  const rec = runs.get(id);
  if (!rec) return;
  rec.status = 'done';
  rec.stage = 'done';
  rec.result = result || null;
  rec.updatedAt = Date.now();
  persist(rec);
}

function fail(id, error) {
  const rec = runs.get(id);
  if (!rec) return;
  rec.status = 'error';
  rec.error = error || { message: 'Run failed.' };
  rec.updatedAt = Date.now();
  persist(rec);
}

/** Look up a run: memory first, then disk (survives a server restart). */
function get(id) {
  const mem = runs.get(id);
  if (mem) return mem;
  try {
    const raw = fs.readFileSync(fileFor(id), 'utf8');
    const rec = JSON.parse(raw);
    // A run marked 'running' on disk whose process is gone cannot resume —
    // report it honestly instead of leaving the UI spinning forever.
    if (rec.status === 'running') {
      rec.status = 'error';
      rec.error = {
        code: 'run_interrupted',
        message: 'The server restarted while this build was running, so it could not finish. Nothing was published — start the build again.',
      };
    }
    return rec;
  } catch (_) {
    return null;
  }
}

/** Drop old records so memory and disk do not grow without bound. */
function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, rec] of runs) {
    if (rec.updatedAt < cutoff) {
      runs.delete(id);
      try { fs.unlinkSync(fileFor(id)); } catch (_) { /* already gone */ }
    }
  }
  try {
    for (const f of fs.readdirSync(runsDir())) {
      const p = path.join(runsDir(), f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* dir may not exist yet */ }
}

const timer = setInterval(sweep, SWEEP_MS);
if (timer.unref) timer.unref();

module.exports = { start, update, finish, fail, get, sweep };
