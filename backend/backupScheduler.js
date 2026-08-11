/**
 * ============================================================
 * FILE: backend/backupScheduler.js
 *
 * Scheduled zip backups of the backend data directory (history,
 * components, brands) — cheap insurance against a corrupted or
 * deleted data folder.
 *
 * startBackupScheduler() — call once from server.js at boot:
 *   - runs one backup immediately if none exists from today
 *   - then every EAI_BACKUP_INTERVAL_HOURS (default 24) zips
 *     backend/data -> backend/backups/backup-YYYY-MM-DD-HHmm.zip
 *   - keeps only the newest 7 backups
 *   - logs one line per backup; NEVER crashes the server — every
 *     failure is caught and logged as a warning.
 *
 * stopBackupScheduler() — clears the interval (exported for tests).
 * runBackupNow() — one immediate backup, resolves to the zip path
 *   or null on failure/no data (exported for tests).
 *
 * ENV:
 *   EAI_BACKUP_INTERVAL_HOURS  hours between backups (default 24)
 *   EAI_DATA_DIR               data dir override (default backend/data)
 *   EAI_BACKUP_DIR             backup dir override (default backend/backups)
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const KEEP_NEWEST = 7;

let timer = null;

function dataDir() {
  return process.env.EAI_DATA_DIR || path.join(__dirname, 'data');
}

function backupDir() {
  return process.env.EAI_BACKUP_DIR || path.join(__dirname, 'backups');
}

function intervalMs() {
  const hours = Number(process.env.EAI_BACKUP_INTERVAL_HOURS);
  const h = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return h * 60 * 60 * 1000;
}

/** Local-time stamp: YYYY-MM-DD-HHmm. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Zip srcDir into outFile using archiver. Rejects on any stream error. */
function zipDirectory(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    let archiverMod;
    try {
      archiverMod = require('archiver');
    } catch (err) {
      return reject(new Error('archiver is not installed: ' + err.message));
    }
    // archiver <=7 exports a factory function; v8 exports { ZipArchive, ... }.
    let archive;
    if (typeof archiverMod === 'function') {
      archive = archiverMod('zip', { zlib: { level: 9 } });
    } else if (archiverMod && typeof archiverMod.ZipArchive === 'function') {
      archive = new archiverMod.ZipArchive({ zlib: { level: 9 } });
    } else {
      return reject(new Error('Unsupported archiver module shape.'));
    }
    const output = fs.createWriteStream(outFile);
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, 'data');
    archive.finalize();
  });
}

/** Delete all but the newest KEEP_NEWEST backup zips. Best-effort. */
function pruneOldBackups(dir) {
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/.test(f))
      .map((f) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) {}
        return { f, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return;
  }
  for (const { f } of files.slice(KEEP_NEWEST)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* best-effort */ }
  }
}

/** Is there already a backup zip from today's date? */
function hasBackupFromToday() {
  const prefix = `backup-${stamp().slice(0, 10)}`; // backup-YYYY-MM-DD
  try {
    return fs.readdirSync(backupDir()).some((f) => f.startsWith(prefix) && f.endsWith('.zip'));
  } catch (_) {
    return false; // backup dir missing -> no backups yet
  }
}

/**
 * Run one backup now. Never throws; resolves to the zip file path,
 * or null when there is nothing to back up or the backup failed.
 */
async function runBackupNow() {
  try {
    const src = dataDir();
    if (!fs.existsSync(src)) {
      console.log('[backup] no data directory yet, skipping backup.');
      return null;
    }
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `backup-${stamp()}.zip`);
    await zipDirectory(src, file);
    pruneOldBackups(dir);
    const kb = Math.max(1, Math.round(fs.statSync(file).size / 1024));
    console.log(`[backup] wrote ${file} (${kb} KB, keeping newest ${KEEP_NEWEST}).`);

    // EXTERNAL STORAGE: mirror the zip to EAI_BACKUP_COPY_DIR when set —
    // point it at a synced folder (Google Drive / Dropbox / OneDrive / NAS)
    // for true off-machine backups. Copy failures are non-fatal.
    const copyDir = process.env.EAI_BACKUP_COPY_DIR;
    if (copyDir) {
      try {
        fs.mkdirSync(copyDir, { recursive: true });
        const dest = path.join(copyDir, path.basename(file));
        fs.copyFileSync(file, dest);
        pruneOldBackups(copyDir);
        console.log(`[backup] mirrored to external destination ${dest}.`);
      } catch (copyErr) {
        console.warn('[backup] external copy failed (non-fatal):', copyErr.message);
      }
    }
    return file;
  } catch (err) {
    console.warn('[backup] backup failed (non-fatal):', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * Start the scheduler. Safe to call more than once (restarts the
 * interval). Any startup failure is logged, never thrown.
 */
function startBackupScheduler() {
  try {
    stopBackupScheduler();
    // One backup at startup if none exists from today (fire-and-forget).
    if (!hasBackupFromToday()) {
      runBackupNow();
    }
    timer = setInterval(() => { runBackupNow(); }, intervalMs());
    // Never keep the process alive just for backups.
    if (timer && typeof timer.unref === 'function') timer.unref();
    console.log(`[backup] scheduler started (every ${intervalMs() / 3600000}h -> ${backupDir()}).`);
  } catch (err) {
    console.warn('[backup] scheduler failed to start (non-fatal):', err && err.message ? err.message : err);
  }
}

/** Stop the scheduler (exported for tests). */
function stopBackupScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startBackupScheduler, stopBackupScheduler, runBackupNow };
