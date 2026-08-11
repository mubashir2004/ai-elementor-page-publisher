/**
 * ============================================================
 * FILE: frontend/src/api.js
 * OWNER: Person 3 + Person 9 (shared frontend client)
 *
 * All backend calls. Credentials never live here beyond the
 * single connect POST — the backend session holds them.
 *
 * SSE note: /api/generate and /api/refine are POST + Server-Sent
 * Events. EventSource only supports GET, so we read the stream
 * manually via fetch + ReadableStream.
 * ============================================================
 */

import * as pdfjsLib from 'pdfjs-dist';

// Vite-style worker wiring: the worker module is resolved and bundled as an
// asset URL at build time, so PDF parsing runs off the main thread.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8787';

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Request failed (${res.status}).`;
    throw new Error(msg);
  }
  return data;
}

async function deleteJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Request failed (${res.status}).`;
    throw new Error(msg);
  }
  return data;
}

async function putJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Request failed (${res.status}).`;
    throw new Error(msg);
  }
  return data;
}

export async function testConnection(creds) {
  return postJson('/api/connect/test', creds);
}

export async function disconnect() {
  return postJson('/api/disconnect', {});
}

/** Run one real Gemini image generation to prove the key works. */
export async function testGeminiKey(geminiKey) {
  return postJson('/api/gemini/test', { geminiKey });
}

/** Fetch the built-in starter briefs (ready-to-use generation prompts). No credentials required. */
export async function getStarterBriefs() {
  const res = await fetch(`${BASE}/api/starter-briefs`, { credentials: 'include' });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load starter briefs.';
    throw new Error(msg);
  }
  return Array.isArray(data) ? data : [];
}

/** Fetch the built-in brand-kit presets. No credentials required. */
export async function getBrandKits() {
  const res = await fetch(`${BASE}/api/brand-kits`, { credentials: 'include' });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load brand kits.';
    throw new Error(msg);
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Render a page JSON to a preview HTML document. No credentials required.
 * @param {object} pageJson
 * @param {{device?: 'desktop'|'tablet'|'mobile', interactive?: boolean}} [opts]
 *        device      — render THAT device's responsive keys (default desktop)
 *        interactive — clicking a top-level section inside the iframe posts
 *                      {type:'eai-select-section', index} to window.parent
 */
export async function previewPage(pageJson, opts = {}) {
  return postJson('/api/preview', {
    pageJson,
    device: opts.device || 'desktop',
    interactive: !!opts.interactive,
  });
}

export async function copySection(targetPageId, sectionJson, index) {
  return postJson('/api/sections/copy', { targetPageId, sectionJson, index });
}

export async function listPages() {
  const res = await fetch(`${BASE}/api/pages`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load pages.';
    throw new Error(msg);
  }
  return data;
}

/**
 * Version history for a page.
 * @param {number|string} pageId
 * @returns {Promise<Array<{versionId, ts, source, title, summary}>>}
 */
export async function getHistory(pageId) {
  const res = await fetch(`${BASE}/api/history?pageId=${encodeURIComponent(pageId)}`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load version history.';
    throw new Error(msg);
  }
  return Array.isArray(data.versions) ? data.versions : [];
}

/**
 * A single stored version, including its pageJson (for preview).
 * @returns {Promise<object>} the version record ({ ..., pageJson })
 */
export async function getHistoryVersion(pageId, versionId) {
  const qs = `pageId=${encodeURIComponent(pageId)}&versionId=${encodeURIComponent(versionId)}`;
  const res = await fetch(`${BASE}/api/history/version?${qs}`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load that version.';
    throw new Error(msg);
  }
  return data.version || null;
}

/**
 * Restore a stored version onto the live page.
 * @returns {Promise<{pageId, pageUrl, editorUrl, status}>}
 */
export async function restoreVersion(pageId, versionId) {
  return postJson('/api/history/restore', { pageId, versionId });
}

/**
 * The connected site's Elementor global colors/typography.
 * @returns {Promise<{available: boolean, system_colors?: [], custom_colors?: [],
 *                    system_typography?: [], custom_typography?: [], message?: string}>}
 */
export async function getGlobals() {
  const res = await fetch(`${BASE}/api/globals`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load Elementor globals.';
    throw new Error(msg);
  }
  return data;
}

/**
 * Stream a generate/refine run.
 * @param {string} path  '/api/generate' | '/api/refine'
 * @param {object} body
 * @param {object} handlers { onProgress(stage, detail), onDone(result), onError(err) }
 *        detail — optional short live string (e.g. '38,400 chars written') that
 *        updates repeatedly while the stage stays the same.
 */
export async function streamRun(path, body, handlers) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    // Non-stream error (e.g. 401 not connected) comes back as JSON.
    const data = await res.json().catch(() => ({}));
    handlers.onError && handlers.onError({
      message: (data && data.error && data.error.message) || `Run failed (${res.status}).`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleFrame(frame, handlers);
    }
  }
  // flush any trailing frame
  if (buffer.trim()) handleFrame(buffer, handlers);
}

function handleFrame(frame, handlers) {
  let event = 'message';
  let dataLine = '';
  frame.split('\n').forEach((line) => {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
  });

  let data = {};
  try {
    data = dataLine ? JSON.parse(dataLine) : {};
  } catch (_) {
    /* ignore malformed frame */
  }

  if (event === 'progress') handlers.onProgress && handlers.onProgress(data.stage, data.detail);
  else if (event === 'done') handlers.onDone && handlers.onDone(data);
  else if (event === 'error') handlers.onError && handlers.onError(data);
}

/* ---- Component library (saved sections, reusable across pages) ---- */

/**
 * Saved components.
 * @returns {Promise<Array<{id, name, type, createdAt}>>}
 */
export async function listComponents() {
  const res = await fetch(`${BASE}/api/components`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load the component library.';
    throw new Error(msg);
  }
  // Defensive: accept both the wrapped shape and a bare array.
  return Array.isArray(data) ? data : (Array.isArray(data.components) ? data.components : []);
}

/**
 * Save one section as a reusable component.
 * @param {{name: string, type: string, element: object}} body
 * @returns {Promise<{id}>}
 */
export async function saveComponent(body) {
  return postJson('/api/components', body);
}

export async function deleteComponent(id) {
  return deleteJson(`/api/components/${encodeURIComponent(id)}`);
}

/* ---- Saved brands (My brands) ---- */

/**
 * Saved brands.
 * @returns {Promise<Array<{id, name, palette, fonts, context}>>}
 */
export async function listBrands() {
  const res = await fetch(`${BASE}/api/brands`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load saved brands.';
    throw new Error(msg);
  }
  // Defensive: accept both the wrapped shape and a bare array.
  return Array.isArray(data) ? data : (Array.isArray(data.brands) ? data.brands : []);
}

/**
 * Save a brand for reuse.
 * scope 'all' = shared across every site you connect; 'site' = this site only.
 * @param {{name: string, palette?: object, fonts?: object, context?: string,
 *          scope?: 'site'|'all'}} body
 * @returns {Promise<{id}>}
 */
export async function saveBrand(body) {
  return postJson('/api/brands', body);
}

/**
 * Update a saved brand (the backend keeps a revision of the previous state).
 * @param {number|string} id
 * @param {{name?: string, palette?: object, fonts?: object, context?: string,
 *          scope?: 'site'|'all'}} patch
 * @returns {Promise<{ok: boolean}>}
 */
export async function updateBrand(id, patch) {
  return putJson(`/api/brands/${encodeURIComponent(id)}`, patch);
}

export async function deleteBrand(id) {
  return deleteJson(`/api/brands/${encodeURIComponent(id)}`);
}

/**
 * Scan a public website for reference screenshots + design hints.
 * @returns {Promise<{images: Array<{base64, mediaType, name}>,
 *                    hints: {colors: [], fonts: [], title}}>}
 */
export async function scanWebsite(url) {
  return postJson('/api/scan', { url });
}

/**
 * Republish a page with locally edited JSON (e.g. reordered sections).
 * @returns {Promise<{pageId, pageUrl, editorUrl, status}>}
 */
export async function republishPage(pageId, pageJson) {
  return postJson('/api/republish', { pageId, pageJson });
}

/**
 * AI picks which SAVED components fit the current brief.
 * @returns {Promise<Array<{id, reason}>>} empty when none fit
 */
export async function suggestComponents(prompt) {
  const data = await postJson('/api/components/suggest', { prompt });
  // Defensive: accept both the wrapped shape and a bare array.
  const picks = Array.isArray(data) ? data : (Array.isArray(data && data.picks) ? data.picks : []);
  return picks.filter((p) => p && p.id != null);
}

/**
 * Aggregated Pro-widget usage across all past generations for this site.
 * @returns {Promise<{runs: number, since: string|null,
 *                    widgets: Array<{widget, totalCount, runs, freeAlternative}>}>}
 */
export async function getProUsage() {
  const res = await fetch(`${BASE}/api/pro-usage`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load Pro widget usage.';
    throw new Error(msg);
  }
  return {
    runs: Number(data && data.runs) || 0,
    since: (data && data.since) || null,
    widgets: Array.isArray(data && data.widgets) ? data.widgets.filter((w) => w && w.widget) : [],
  };
}

/**
 * The site's Elementor global widgets.
 * @returns {Promise<{available: boolean, widgets: Array<{id, title}>, message: string}>}
 *          available:false when Elementor Pro or plugin v1.3.0 is missing.
 */
export async function getGlobalWidgets() {
  const res = await fetch(`${BASE}/api/global-widgets`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'Could not load global widgets.';
    throw new Error(msg);
  }
  return {
    available: !!(data && data.available),
    widgets: Array.isArray(data && data.widgets) ? data.widgets.filter((w) => w && w.id != null) : [],
    message: (data && data.message) || '',
  };
}

/**
 * Convert a saved component into an Elementor global widget.
 * A 400 error carries a clear backend message (e.g. the component isn't a
 * single widget) — surface it verbatim.
 * @returns {Promise<{id, title}>}
 */
export async function createGlobalWidget(componentId, title) {
  return postJson('/api/global-widgets', { componentId, title: title || undefined });
}

/**
 * AI improvement suggestions for a generated page.
 * @returns {Promise<Array<{text, refinePrompt}>>}
 */
export async function getSuggestions(pageJson, prompt) {
  const data = await postJson('/api/suggest', { pageJson, prompt: prompt || undefined });
  // Defensive: accept both the wrapped shape and a bare array.
  return Array.isArray(data) ? data : (Array.isArray(data && data.suggestions) ? data.suggestions : []);
}

/** Read a File into { base64, mediaType } for the image upload payload. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const comma = result.indexOf(',');
      resolve({
        base64: comma !== -1 ? result.slice(comma + 1) : result,
        mediaType: file.type || 'image/jpeg',
        name: file.name,
      });
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

// The Claude API rejects images larger than ~5 MB (decoded), so big uploads
// are auto-downscaled in the browser before sending. A ~2200px-long-edge JPEG
// keeps every detail the design analysis needs while staying API-safe.
const API_SAFE_BYTES = 4.5 * 1024 * 1024;
const MAX_EDGE_PX = 2200;

/**
 * Read a File (up to the UI limit) into an API-safe { base64, mediaType, name }.
 * Files already under the byte budget pass through untouched; larger ones are
 * drawn to a canvas (long edge capped) and re-encoded as JPEG, stepping the
 * quality down until the payload fits.
 *
 * @param {File} file
 * @param {number} [targetBytes]  decoded-byte budget for this image
 *                                (defaults to the single-image API-safe cap;
 *                                pass a smaller budget when sending many refs)
 * @param {number} [maxEdge]      long-edge pixel cap for the re-encode pass
 */
export async function fileToOptimizedBase64(file, targetBytes = API_SAFE_BYTES, maxEdge = MAX_EDGE_PX) {
  if (file.size <= targetBytes) return fileToBase64(file);

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White backdrop so transparent PNG regions don't turn black in JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();

  for (const quality of [0.85, 0.75, 0.65, 0.5]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    // base64 is ~4/3 of the decoded size; compare decoded bytes to the cap.
    if (base64.length * 0.75 <= targetBytes) {
      return { base64, mediaType: 'image/jpeg', name: file.name };
    }
  }
  // Last resort: lowest-quality result (still almost always well under cap).
  const dataUrl = canvas.toDataURL('image/jpeg', 0.4);
  return {
    base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mediaType: 'image/jpeg',
    name: file.name,
  };
}

// PDF pages are rasterized so the long edge lands near 1600px — plenty of
// detail for design analysis while keeping each page JPEG small.
const PDF_PAGE_EDGE_PX = 1600;

/**
 * Render a PDF's pages to reference images.
 * Each page is drawn to a canvas (scaled so the long edge is ~1600px) and
 * encoded as JPEG at quality 0.82.
 *
 * @param {File} file            a PDF File
 * @param {number} [maxPages=20] hard cap on rendered pages
 * @returns {Promise<Array<{ base64: string, mediaType: 'image/jpeg', name: string }>>}
 */
export async function pdfToImages(file, maxPages = 30) {
  const data = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const out = [];
  // Expose the true page count so callers can WARN when a PDF is truncated
  // instead of silently dropping pages (attached as a property on the array).
  let totalPages = 0;
  try {
    totalPages = doc.numPages;
    const pageCount = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = PDF_PAGE_EDGE_PX / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      // White backdrop: PDF pages can have transparent backgrounds.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, viewport }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      out.push({
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        mediaType: 'image/jpeg',
        name: `${file.name} — page ${i}`,
      });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  out.totalPages = totalPages;
  return out;
}
