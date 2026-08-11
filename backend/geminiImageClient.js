/**
 * ============================================================
 * FILE: backend/geminiImageClient.js
 *
 * Defensive wrapper over Google's Generative Language API used to
 * generate marketing images for pages. Server-side only.
 *
 *   generateImage(prompt, apiKey, opts={})
 *     -> { buffer: Buffer, mime: string, ext: string } | null
 *
 * Never throws: any error, missing key, or missing image part -> null.
 *
 * Model strategy:
 *   1. Try the default image model ('gemini-2.5-flash-image').
 *   2. If it 404s / NOT_FOUND, retry once with the preview model
 *      ('gemini-2.0-flash-preview-image-generation').
 *   3. If a 400 complains about responseModalities/generationConfig,
 *      retry the same model without the generationConfig block.
 * ============================================================
 */

'use strict';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const FALLBACK_MODEL = 'gemini-2.0-flash-preview-image-generation';
const TIMEOUT_MS = 45000;

const PROMPT_PREFIX =
  'Generate a high-quality, photorealistic marketing image. ' +
  'No text, no words, no watermark, no logo. Subject: ';

/**
 * Perform a single generateContent call against a specific model.
 * Returns an object describing the outcome so the caller can decide
 * whether to retry with a different model or config.
 *
 * @returns {Promise<{
 *   image: {buffer:Buffer, mime:string, ext:string}|null,
 *   status: number,
 *   errorText: string
 * }>}
 */
async function callModel(model, apiKey, fullText, includeGenerationConfig) {
  const url = `${API_BASE}/${model}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: fullText }] }],
  };
  if (includeGenerationConfig) {
    body.generationConfig = { responseModalities: ['IMAGE'] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const status = res ? res.status : 0;

    if (!res || !res.ok) {
      let errorText = '';
      try {
        errorText = await res.text();
      } catch (_) {
        errorText = '';
      }
      return { image: null, status, errorText };
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      return { image: null, status, errorText: '' };
    }

    const image = extractImage(data);
    return { image, status, errorText: '' };
  } catch (_) {
    // Aborts, network errors — treated as a soft failure (no retry signal).
    return { image: null, status: 0, errorText: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the response candidates and pull out the first inlineData image part.
 *
 * @returns {{buffer:Buffer, mime:string, ext:string}|null}
 */
function extractImage(data) {
  const candidates =
    data && Array.isArray(data.candidates) ? data.candidates : [];
  const first = candidates[0];
  const parts =
    first && first.content && Array.isArray(first.content.parts)
      ? first.content.parts
      : [];

  for (const part of parts) {
    const inline = part && (part.inlineData || part.inline_data);
    if (inline && inline.data) {
      let buffer;
      try {
        buffer = Buffer.from(inline.data, 'base64');
      } catch (_) {
        continue;
      }
      if (!buffer || buffer.length === 0) continue;

      const mime = inline.mimeType || inline.mime_type || 'image/png';
      const ext = (mime.split('/')[1] || 'png').split(';')[0].trim() || 'png';
      return { buffer, mime, ext };
    }
  }
  return null;
}

/**
 * Should we retry with the fallback model? (model not found)
 */
function isNotFound(status, errorText) {
  return status === 404 || /NOT_FOUND/i.test(String(errorText || ''));
}

/**
 * Should we retry without the generationConfig block?
 */
function isConfigComplaint(status, errorText) {
  return (
    status === 400 &&
    /responseModalities|generationConfig/i.test(String(errorText || ''))
  );
}

/**
 * Generate a single image for the given prompt.
 *
 * @param {string} prompt   free-text subject of the image
 * @param {string} apiKey   Google Generative Language API key ('' if none)
 * @param {object} [opts]   { model?: string }
 * @returns {Promise<{buffer:Buffer, mime:string, ext:string}|null>}
 */
async function generateImage(prompt, apiKey, opts = {}) {
  const subject = String(prompt || '').trim();
  const key = String(apiKey || '').trim();
  if (!key) return null;

  const fullText = PROMPT_PREFIX + (subject || 'an abstract marketing scene');
  const primaryModel = (opts && opts.model) || DEFAULT_MODEL;

  try {
    // Attempt 1: primary model, with generationConfig.
    let res = await callModel(primaryModel, key, fullText, true);
    if (res.image) return res.image;

    // Retry without generationConfig if the API complained about it.
    if (isConfigComplaint(res.status, res.errorText)) {
      const noCfg = await callModel(primaryModel, key, fullText, false);
      if (noCfg.image) return noCfg.image;
      // Fall through to model fallback if this also failed as NOT_FOUND.
      res = noCfg;
    }

    // Retry with the fallback model if the primary was not found.
    if (isNotFound(res.status, res.errorText)) {
      let fb = await callModel(FALLBACK_MODEL, key, fullText, true);
      if (fb.image) return fb.image;

      if (isConfigComplaint(fb.status, fb.errorText)) {
        fb = await callModel(FALLBACK_MODEL, key, fullText, false);
        if (fb.image) return fb.image;
      }
    }

    return null;
  } catch (_) {
    // Belt-and-suspenders: contract says never throw.
    return null;
  }
}

module.exports = { generateImage };
