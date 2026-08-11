/**
 * ============================================================
 * FILE: backend/imageOptimizer.js
 *
 * Best-effort image optimization for generated images before they
 * are uploaded to the WordPress media library.
 *
 * EXPORT:
 *   optimizeImage(buffer, mime) -> Promise<{ buffer, mime, ext }>
 *
 * Behavior:
 *   - Only touches images wider than 1920px OR heavier than 400 KB.
 *   - Resizes to max width 1920 and re-encodes as JPEG quality 82.
 *   - Keeps PNG only when the source PNG actually has an alpha
 *     channel (sharp metadata hasAlpha) — transparency would be
 *     destroyed by JPEG.
 *   - NEVER throws and never blocks a publish: if sharp is not
 *     installed, the buffer is garbage, or any sharp call fails,
 *     the ORIGINAL { buffer, mime, ext } is returned unchanged.
 * ============================================================
 */

'use strict';

const MAX_WIDTH = 1920;
const MAX_BYTES = 400 * 1024; // 400 KB
const JPEG_QUALITY = 82;

// sharp is an optional native dependency — load it lazily and only once,
// so a missing/broken install degrades to a no-op instead of crashing.
let sharpModule;
let sharpTried = false;
function loadSharp() {
  if (!sharpTried) {
    sharpTried = true;
    try {
      sharpModule = require('sharp');
    } catch (_) {
      sharpModule = null;
    }
  }
  return sharpModule;
}

/** Map a mime type to a sensible file extension (defaults to png). */
function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('svg')) return 'svg';
  if (m.includes('avif')) return 'avif';
  return 'png';
}

/**
 * Optimize an image buffer. Always resolves to { buffer, mime, ext };
 * on ANY failure the original bytes come back untouched.
 */
async function optimizeImage(buffer, mime) {
  const original = {
    buffer,
    mime: mime || 'image/png',
    ext: extFromMime(mime),
  };

  try {
    const sharp = loadSharp();
    if (!sharp || !Buffer.isBuffer(buffer) || buffer.length === 0) return original;

    const meta = await sharp(buffer).metadata();
    const width = Number(meta.width) || 0;
    const tooWide = width > MAX_WIDTH;
    const tooHeavy = buffer.length > MAX_BYTES;
    if (!tooWide && !tooHeavy) return original; // already small enough

    let pipeline = sharp(buffer);
    if (tooWide) {
      pipeline = pipeline.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    }

    // Keep PNG only when the source PNG really uses transparency;
    // everything else re-encodes to JPEG (much smaller for photos).
    const keepPng = meta.format === 'png' && meta.hasAlpha === true;
    let out;
    let outMime;
    let outExt;
    if (keepPng) {
      out = await pipeline.png().toBuffer();
      outMime = 'image/png';
      outExt = 'png';
    } else {
      out = await pipeline.flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      outMime = 'image/jpeg';
      outExt = 'jpg';
    }

    if (!Buffer.isBuffer(out) || out.length === 0) return original;
    // Never "optimize" into a bigger file when we didn't have to resize.
    if (!tooWide && out.length >= buffer.length) return original;

    return { buffer: out, mime: outMime, ext: outExt };
  } catch (_) {
    return original; // any sharp failure -> original bytes, never throw
  }
}

module.exports = { optimizeImage };
