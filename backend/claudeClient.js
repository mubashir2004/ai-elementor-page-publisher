/**
 * ============================================================
 * FILE: backend/claudeClient.js
 * OWNER: Person 4 (Claude Client & Pipeline Orchestrator)
 *
 * Wraps the Anthropic Messages API with the user's BYOK key.
 * Provides: design extraction (Pass 1), page generation (Pass 2),
 * self-critique refine (critiquePage), and JSON repair —
 * with exponential backoff on 429/529.
 *
 * Model / params are locked by the shared contract.
 * Never log the key or full prompt bodies.
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ANTHROPIC_URL = process.env.EAI_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const MODEL_DEFAULT = 'claude-opus-4-8';
const MAX_TOKENS = 32000;
// A full page can exceed one max_tokens window. If a segment stops on
// `max_tokens` we continue it (assistant prefill) up to this many segments so
// the JSON comes back COMPLETE instead of truncated (the old truncation was the
// "Could not obtain valid JSON" cause). 3 × 32k = plenty for any page.
const MAX_OUTPUT_SEGMENTS = 3;
const TEMPERATURE = 0.2;

// Continuation directive. NOTE: newer models reject assistant-message *prefill*
// (a request ending on an assistant turn), so we continue by appending the
// partial as a normal assistant turn followed by this USER turn — the request
// still ends on a user message, which every model accepts.
const CONTINUE_INSTRUCTION =
  'Your previous reply was cut off before it finished. Continue the output EXACTLY ' +
  'from the character where it stopped. Output ONLY the remaining raw JSON: do not ' +
  'repeat any earlier content, do not restart, and do not add explanations or ' +
  'markdown code fences. Begin with the very next character.';
const ANTHROPIC_VERSION = '2023-06-01';

// ------------------------------------------------------------------
// GLOBAL CONCURRENCY GATE. Parallel variations x parallel polish passes
// can burst 9+ simultaneous API calls — the provider rate-limits the burst
// and every call lands in exponential-backoff purgatory (much slower than
// queuing). Cap concurrent requests server-wide; extras wait their turn.
// ------------------------------------------------------------------
const MAX_CONCURRENT_REQUESTS = 3;
let activeRequests = 0;
const requestQueue = [];
async function withConcurrencyGate(fn) {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise((resolve) => requestQueue.push(resolve));
  }
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
    const next = requestQueue.shift();
    if (next) next();
  }
}



// Opus 4.7+, Sonnet 5, and Fable/Mythos 5 REMOVED the sampling params — sending
// `temperature` (or top_p/top_k) returns HTTP 400. Older models (Opus 4.6/4.5,
// Sonnet 4.6/4.5, Haiku 4.5, …) still accept it. Default to sending it and omit
// it only for the known no-sampling model families.
function modelAcceptsTemperature(model) {
  const m = String(model || '');
  if (/opus-4-[789]\b/.test(m)) return false;            // Opus 4.7 / 4.8 / 4.9
  if (/(sonnet|fable|mythos)-5\b/.test(m)) return false; // Sonnet 5, Fable 5, Mythos 5
  return true;
}

// Pro-only block markers inside page-gen.v2.md (lines must match exactly).
const PRO_ONLY_START = '<!-- PRO_ONLY_START -->';
const PRO_ONLY_END = '<!-- PRO_ONLY_END -->';

// Load the versioned prompts once at startup.
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
// page-gen.v2.md still contains the PRO_ONLY_START/END markers after the
// header strip; the block is included/excluded per-request based on allowPro.
const PAGE_GEN_PROMPT = readPrompt('page-gen.v2.md');
const DESIGN_EXTRACT_PROMPT = readPrompt('design-extract.v1.md');
const REFINE_PROMPT = readPrompt('refine.v1.md');
// The per-widget knowledge base (Content/Style/Advanced tabs as JSON keys),
// distilled from the owner's Elementor widget dictionary. Appended to the
// page-gen system prompt; contains its own PRO_ONLY block.
const WIDGET_REFERENCE = readPrompt('widget-reference.v1.md');
// Design recipes — authoritative for widget selection per section type,
// alignment fidelity, spacing rhythm, mobile-first rules, split-photo builds,
// and posts-band dressing. Appended to BOTH the page-gen and refine system
// prompts so it is always in context. No PRO_ONLY markers (its Pro mentions
// are self-gated by prose).
const DESIGN_RECIPES = readPrompt('design-recipes.v1.md');
// Pro foundations mined from the owner's professional template kits.
const PRO_PATTERNS = readPrompt('pro-patterns.v1.md');

function readPrompt(file) {
  const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
  // Strip the leading HTML doc-comment header. The header may QUOTE marker
  // strings containing "-->" (e.g. "<!-- PRO_ONLY_START -->"), so a naive
  // indexOf('-->') cuts too early and leaks header junk into the prompt.
  // The header always closes with "-->" alone on its own line — cut there.
  if (raw.trimStart().startsWith('<!--')) {
    const lines = raw.split('\n');
    const closeIdx = lines.findIndex((l) => l.trim() === '-->');
    if (closeIdx !== -1) return lines.slice(closeIdx + 1).join('\n').trim();
  }
  const idx = raw.indexOf('-->');
  return idx !== -1 ? raw.slice(idx + 3).trim() : raw.trim();
}

/**
 * Include or exclude EVERY PRO_ONLY block in the given prompt text (the main
 * prompt and the widget reference each carry one).
 * - allowPro true  -> keep each block's content, drop only the marker lines.
 * - allowPro false -> drop each block's content AND the marker lines.
 * Unmatched/malformed markers leave the remaining text unchanged.
 */
function applyProBlock(text, allowPro) {
  let lines = text.split('\n');
  for (;;) {
    const startIdx = lines.findIndex((l) => l.trim() === PRO_ONLY_START);
    if (startIdx === -1) break;
    const endRel = lines.slice(startIdx + 1).findIndex((l) => l.trim() === PRO_ONLY_END);
    if (endRel === -1) break; // malformed — stop processing
    const endIdx = startIdx + 1 + endRel;
    lines = allowPro
      ? [...lines.slice(0, startIdx), ...lines.slice(startIdx + 1, endIdx), ...lines.slice(endIdx + 1)]
      : [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
  }
  return lines.join('\n').trim();
}

/**
 * Build the brand-injection suffix appended ONLY to the user message
 * (never to the cached system prompt).
 */
function brandInjection(brandContext, brandKit) {
  let s = '';
  if (brandContext) {
    s += `\n\n<brand_context>${brandContext}</brand_context>`;
  }
  if (brandKit) {
    s +=
      `\n\n<brand_kit>${JSON.stringify(brandKit)}</brand_kit>\n` +
      'Use this brand kit as the source of truth for the page: apply its ' +
      'palette (backgrounds, surfaces, text, headings, accent) and its ' +
      'heading/body fonts via native Elementor settings throughout.';
  }
  return s;
}

/**
 * The FULL assembled page-generation system prompt (main prompt + per-widget
 * knowledge base + design recipes, PRO blocks applied). Shared by
 * generatePage AND refineElement so a section refine has the exact same
 * widget knowledge as a full generation — and the prompt-cache prefix is
 * byte-identical between the two calls.
 */
function pageGenSystem(allowPro) {
  return applyProBlock(
    PAGE_GEN_PROMPT + '\n\n' + WIDGET_REFERENCE + '\n\n' + DESIGN_RECIPES + '\n\n' + PRO_PATTERNS,
    allowPro
  );
}

/**
 * Factory — bind an API key + model to a set of callable methods.
 * `createClaudeClient` keeps the key in closure scope, never on the object.
 */
function createClaudeClient(apiKey, model = MODEL_DEFAULT, opts = {}) {
  // Transport: 'api' (default — HTTP with the key) or 'cli' (the locally
  // installed Claude Code binary and its own login; no API key involved).
  const useCli = !!(opts && opts.useCli);
  if (!apiKey && !useCli) throw new Error('Missing Claude API key.');

  // One streamed request. Returns { text, stopReason }. Streaming avoids the
  // ~5-minute undici headers timeout (headers arrive immediately, tokens flow).
  // `onDelta(totalChars)` (optional) is invoked at most ~1x/sec as text arrives.
  async function streamOnce({ system, messages, onDelta }) {
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          // Omit temperature for models that reject it (Opus 4.7+/Sonnet 5/Fable 5).
          ...(modelAcceptsTemperature(model) ? { temperature: TEMPERATURE } : {}),
          stream: true,
          // PROMPT CACHING: send the (large, stable) system prompt as a cached
          // text block so the generate/refine calls of a session reuse it at
          // ~0.1x input price instead of re-processing ~80KB every call.
          // Non-string systems (or empty ones) pass through unchanged.
          system: typeof system === 'string' && system
            ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
            : system,
          messages,
        }),
      });
    } catch (err) {
      const reason = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'network error';
      const e = new Error(`Could not reach the Claude API (${reason}). Check the API key, network, and that the model is available.`);
      e.retryable = true; // transient — let backoff retry
      throw e;
    }

    if (res.status === 429 || res.status === 529) {
      const retryable = new Error(`Claude overloaded (${res.status}).`);
      retryable.retryable = true;
      throw retryable;
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
    }

    return readStream(res, onDelta); // { text, stopReason }
  }

  /**
   * Get a full completion, transparently continuing across max_tokens windows.
   * If a segment stops on `max_tokens`, we prefill the assistant turn with what
   * we have and ask the model to continue — so even a page larger than one
   * window comes back as ONE complete string (no mid-JSON truncation).
   */
  async function rawMessage({ system, messages, onDelta }) {
    // CLI transport: one full-response call through the local Claude Code
    // binary (it manages its own output internally — no continuation windows).
    // The same concurrency gate applies so parallel passes don't spawn a
    // process storm.
    if (useCli) {
      const cli = require('./claudeCliClient');
      return withConcurrencyGate(() => cli.runMessage({ system, messages, model, onDelta }));
    }
    let full = '';
    for (let seg = 0; seg < MAX_OUTPUT_SEGMENTS; seg++) {
      // Continue a truncated segment with a real assistant turn FOLLOWED BY a
      // user turn — so the request never ends on an assistant prefill (which
      // Sonnet 4.6 / Opus 4.8 reject with HTTP 400).
      const reqMessages = full
        ? [
            ...messages,
            { role: 'assistant', content: full.replace(/\s+$/, '') },
            { role: 'user', content: CONTINUE_INSTRUCTION },
          ]
        : messages;
      // Progress callback reports TOTAL chars across continuation segments.
      const baseLen = full.length;
      const segDelta = typeof onDelta === 'function'
        ? (n) => { try { onDelta(baseLen + n); } catch (_) { /* progress must never break generation */ } }
        : undefined;
      // Per-segment backoff: a transient 429/529 retries just that segment.
      const { text, stopReason } = await withConcurrencyGate(() => withBackoff(() => streamOnce({ system, messages: reqMessages, onDelta: segDelta })));
      full += text;
      if (stopReason !== 'max_tokens') break;
    }
    return full;
  }

  /** PASS 1 — design system from mockup image(s). */
  async function extractDesignSystem(images) {
    const content = [];
    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      });
    }
    content.push({
      type: 'text',
      text: 'Extract the design system from the image(s) as specified. Output raw JSON only.',
    });

    const text = await rawMessage({
      system: DESIGN_EXTRACT_PROMPT,
      messages: [{ role: 'user', content }],
    });
    return text;
  }

  /** PASS 2 — generate the page. designSystem/currentPage optional. */
  async function generatePage({
    prompt,
    designSystem,
    currentPage,
    editInstruction,
    allowPro = false,
    brandContext = '',
    brandKit = null,
    images = [],
    legacyContent = null, // { builder, content } — migrate a non-Elementor page
    onDelta,              // optional progress callback (totalChars), ~1x/sec
  }) {
    let userText = prompt || '';

    if (designSystem) {
      userText += `\n\n<design_system>\n${JSON.stringify(designSystem)}\n</design_system>\n`;
    }
    if (legacyContent && legacyContent.content) {
      // MIGRATION MODE — rebuild a Divi/WPBakery/Gutenberg/classic page as
      // native Elementor while preserving every piece of real content.
      const builder = legacyContent.builder || 'another builder';
      userText +=
        `\n\n<legacy_page_content builder="${builder}">\n` +
        String(legacyContent.content).slice(0, 60000) +
        '\n</legacy_page_content>\n' +
        `\nMIGRATION MODE: the existing page above was built with ${builder}. ` +
        'Rebuild it as a NATIVE Elementor container page. PRESERVE all real ' +
        'content — every heading, paragraph, list, button label, phone number, ' +
        'address, and image URL found in the legacy markup — and strip all ' +
        'shortcode/builder syntax. Reorganize the preserved content into a ' +
        'modern professional layout per the design recipes. Do NOT invent ' +
        'unrelated content and do NOT drop sections that exist in the source.';
    }
    if (currentPage) {
      // Edit mode — give the model the current page and a strict edit directive.
      userText +=
        `\n\n<current_page_json>\n${JSON.stringify(currentPage)}\n</current_page_json>\n` +
        `\nEDIT MODE: Apply ONLY the following changes and keep every other element, id, ` +
        `and setting byte-identical. Return the FULL corrected page JSON.\n` +
        `Changes: ${editInstruction || prompt}\n`;
    }

    // Brand info goes into the user message only (system prompt stays cacheable).
    userText += brandInjection(brandContext, brandKit);

    // Efficiency directive — keeps generation fast and the JSON valid. Apply the
    // styling you intend, but don't bloat the output with defaults or inline SVG
    // (inline SVG is huge AND renders as broken icons; library refs render right).
    userText +=
      '\n\nOUTPUT RULES: Return ONLY the raw JSON object — no prose, no markdown ' +
      'fences. Apply the styling you intend (spacing, colors, typography, ' +
      'backgrounds), but keep the JSON efficient: do not emit empty or default ' +
      'fields you are not using, and for every icon use a Font Awesome library ref ' +
      'like {"value":"fas fa-heartbeat","library":"fa-solid"} — never inline SVG markup.';

    // When reference/mockup images are provided, attach them to the GENERATION
    // turn so the model designs while looking at them (not from an abstract
    // summary) and reproduces the actual layout it sees.
    let content = userText;
    if (Array.isArray(images) && images.length) {
      userText +=
        '\n\nThe REFERENCE DESIGN IMAGE(S) above are the target design. Reproduce the ' +
        'reference layout as closely as native Elementor widgets allow — recreate ' +
        'EVERY section you see in the same order. Do NOT simplify, merge, or drop ' +
        'sections, and do NOT fall back to a generic layout.\n\n' +
        'LAYER ANALYSIS — decide the STRUCTURE of every section before building it:\n' +
        '1. Is the section\'s image a SEPARATE image (photo in its own column, next ' +
        'to the text) or the section\'s BACKGROUND (a wide image the content sits ON ' +
        'TOP of)? They are built completely differently. If content sits ON the ' +
        'image: set the image as the parent section\'s background_image, add the ' +
        'scrim/fade you see (a gradient background_overlay — often darkening or ' +
        'tinting only the content side, the "half shadow"), then place the content ' +
        'in an INNER SECTION or column on the correct side (content on the right = ' +
        'an empty spacer column first, then the content column; content on the left ' +
        '= content column first). The content block itself may be a styled card ' +
        '(background, radius, padding) if the reference shows one.\n' +
        '2. Detect every overlay, gradient fade, floating/overlapping card, rounded ' +
        'corner, and shadow — reproduce them with the exact keys from the system ' +
        'prompt, on the right element (section vs column vs widget).\n' +
        '3. Match alignment precisely: what is left/right/centered in the reference ' +
        'must be the same in the build — column widths, content_position, and ' +
        'text alignment all matter.\n' +
        '4. Match the card styles, image placements, button styles, column counts, ' +
        'and spacing rhythm. Every card in a row identical in size and styling.\n' +
        '5. If the reference has a blog/news/articles section and Pro widgets are ' +
        'available, use the real `posts` widget — never hand-built fake post cards.';
      content = [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        })),
        { type: 'text', text: userText },
      ];
    }

    const text = await rawMessage({
      // Main prompt + the per-widget knowledge base (both are PRO-block aware)
      // + the design recipes addendum (always included; no PRO markers).
      system: pageGenSystem(allowPro),
      messages: [{ role: 'user', content }],
      onDelta,
    });
    return text;
  }

  /**
   * SECTION REFINE — apply one instruction to a SINGLE element from a live
   * page and return only that updated element. Uses the SAME assembled
   * page-gen system prompt so all widget knowledge (and the prompt cache)
   * applies. Returns raw model text (the pipeline parses/normalizes it).
   */
  async function refineElement({
    elementJson,
    instruction,
    allowPro = false,
    brandContext = '',
    images = [],
    onDelta,
  }) {
    const id = elementJson && elementJson.id ? String(elementJson.id) : '';
    let userText =
      'Here is ONE Elementor element from a live page:\n' +
      '<element_json>\n' + JSON.stringify(elementJson) + '\n</element_json>\n' +
      `Apply EXACTLY this change to it: ${instruction || ''}\n` +
      `Return ONLY the updated element as a raw JSON object (same elType, keep the SAME id "${id}"), nothing else.` +
      brandInjection(brandContext, null);

    // Reference image(s): attach so the refine matches what the DESIGN shows,
    // not a text summary of it (used by the deterministic header polish pass).
    let content = userText;
    if (Array.isArray(images) && images.length) {
      userText +=
        '\n\nThe attached REFERENCE DESIGN IMAGE(S) are the target — restyle this ' +
        'element to match what they show for this part of the page EXACTLY.';
      content = [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        })),
        { type: 'text', text: userText },
      ];
    }

    const text = await rawMessage({
      system: pageGenSystem(allowPro),
      messages: [{ role: 'user', content }],
      onDelta,
    });
    return text;
  }

  /**
   * REFINE — self-critique pass. Feed the model the original brief plus the
   * current page JSON and ask for the FULL improved page JSON back.
   * Returns raw model text (validator handles parsing/repair).
   */
  async function critiquePage({ pageJson, prompt, allowPro = false, brandContext = '', images = [] }) {
    void allowPro; // widget policy is enforced downstream by the validator.
    let userText =
      'ORIGINAL BRIEF:\n' +
      (prompt || '') +
      brandInjection(brandContext, null) +
      '\n\n<current_page_json>\n' +
      JSON.stringify(pageJson) +
      '\n</current_page_json>\n\n' +
      'Critique and improve this page, then return ONLY the FULL improved page ' +
      'JSON object using the exact same schema. Output raw JSON only — no prose, ' +
      'no markdown fences.';

    // Reference images make this a VISUAL comparison, not a blind text review:
    // the critique can catch a static map screenshot where the reference shows
    // a live map, a tabs widget where the reference shows cards, wrong section
    // types, missing styling — everything a coded rule can't anticipate.
    let content = userText;
    if (Array.isArray(images) && images.length) {
      userText +=
        '\n\nThe attached REFERENCE DESIGN IMAGE(S) are the ground truth. Compare the ' +
        'current page against them SECTION BY SECTION and fix EVERY discrepancy: wrong ' +
        'widget choices (e.g. a static image where the reference shows a live map or ' +
        'gallery), invented sections the reference lacks, missing sections it shows, ' +
        'wrong layouts (tabs/accordion where the reference shows cards or columns), ' +
        'wrong colors/spacing/typography. Preserve everything already correct verbatim.';
      content = [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        })),
        { type: 'text', text: userText },
      ];
    }

    const text = await rawMessage({
      // Refine also gets the design recipes so the critique pass enforces the
      // same widget-selection / alignment / spacing / mobile standards.
      system: REFINE_PROMPT + '\n\n' + DESIGN_RECIPES + '\n\n' + PRO_PATTERNS,
      messages: [{ role: 'user', content }],
    });
    return text;
  }

  /** Repair malformed JSON — used by validator.js. */
  async function repairJson(brokenText, parseError) {
    const text = await rawMessage({
      system:
        'You fix malformed JSON. You receive text that should be a single JSON object ' +
        'but fails to parse. Return ONLY the corrected, valid JSON object — no prose, ' +
        'no markdown fences, no commentary. Preserve all data; only fix syntax.',
      messages: [
        {
          role: 'user',
          content:
            `Parser error: ${parseError}\n\nFix this into valid JSON (output JSON only):\n\n${brokenText}`,
        },
      ],
    });
    return text;
  }

  /**
   * AI improvement suggestions for a generated page. Returns raw model text
   * (the caller parses; expected shape: {"suggestions":[{text,refinePrompt}]}).
   */
  async function suggestImprovements({ pageJson, prompt = '' }) {
    const text = await rawMessage({
      system:
        'You are a senior conversion-focused web designer reviewing an Elementor ' +
        'page JSON. Return ONLY raw JSON of the shape ' +
        '{"suggestions":[{"text":"human-readable improvement","refinePrompt":"imperative instruction to apply it"}]} ' +
        'with 3-6 concrete, specific suggestions. Focus on: spacing rhythm and ' +
        'alignment, visual hierarchy and type contrast, CTA clarity and placement, ' +
        'trust signals near the ask, image quality/placement, and mobile behavior ' +
        '(wrapping, sizes). Each refinePrompt must be a single self-contained ' +
        'instruction an editor could apply (name the section it targets). ' +
        'No prose, no markdown fences — the first character you emit is { and the last is }.',
      messages: [
        {
          role: 'user',
          content:
            `ORIGINAL BRIEF (may be empty):\n${prompt}\n\n<page_json>\n` +
            JSON.stringify(pageJson) +
            '\n</page_json>\n\nReview the page and output the suggestions JSON only.',
        },
      ],
    });
    return text;
  }

  /**
   * Pick which SAVED components fit a brief. Returns raw model text
   * (expected: {"picks":[{"id":"...","reason":"..."}]}).
   */
  async function suggestComponents({ prompt, components }) {
    const text = await rawMessage({
      system:
        'You match a web-page brief against a library of saved, reusable page ' +
        'blocks. Return ONLY raw JSON {"picks":[{"id":"<component id>","reason":"one short sentence"}]}. ' +
        'Pick ONLY components that genuinely fit the brief (0 to 5 picks); never ' +
        'invent ids. The first character you emit is { and the last is }.',
      messages: [
        {
          role: 'user',
          content:
            `BRIEF:\n${prompt}\n\nSAVED COMPONENTS (id | name | type):\n` +
            components.map((c) => `${c.id} | ${c.name} | ${c.type}`).join('\n') +
            '\n\nOutput the picks JSON only.',
        },
      ],
    });
    return text;
  }

  return {
    rawMessage,
    extractDesignSystem,
    generatePage,
    refineElement,
    critiquePage,
    repairJson,
    suggestImprovements,
    suggestComponents,
    model,
  };
}

/**
 * ------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------
 */

// Concatenate all text blocks from a Messages API response.
function extractText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

/**
 * Read an Anthropic SSE stream and concatenate all text deltas.
 * Falls back to a plain JSON body when the response has no readable stream
 * (the offline test mock returns a non-streaming response).
 * `onDelta(totalChars)` (optional) fires at most ~1x/sec while text arrives.
 */
async function readStream(res, onDelta) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    // Offline test mock returns a non-streaming JSON body.
    const data = await res.json();
    return { text: extractText(data), stopReason: (data && data.stop_reason) || 'end_turn' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = 'end_turn';
  let lastTick = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        text += evt.delta.text;
        if (onDelta) {
          const now = Date.now();
          if (now - lastTick >= 1000) {
            lastTick = now;
            try { onDelta(text.length); } catch (_) { /* progress must never break the stream */ }
          }
        }
      } else if (evt.type === 'message_delta' && evt.delta && evt.delta.stop_reason) {
        // Carries the reason the turn ended — 'max_tokens' means truncated.
        stopReason = evt.delta.stop_reason;
      } else if (evt.type === 'error') {
        const msg = (evt.error && evt.error.message) || 'stream error';
        const e = new Error(`Claude API error: ${msg}`);
        const t = evt.error && evt.error.type;
        if (t === 'overloaded_error' || t === 'rate_limit_error' || t === 'api_error') e.retryable = true;
        throw e;
      }
    }
  }
  return { text, stopReason };
}

// Exponential backoff for retryable (429/529/overloaded) failures.
// Speed policy: at most 2 retries, and no single wait above 20s — a slow
// upstream should fail fast and visibly, not silently stretch a build to
// 40 minutes. Each wait is logged so slowness shows up in server logs.
async function withBackoff(fn, { retries = 2, base = 800, maxDelay = 20000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = err.retryable && attempt < retries;
      if (!canRetry) throw err;
      const delay = Math.min(base * Math.pow(2, attempt) + Math.random() * 300, maxDelay);
      console.warn(`[claude] retryable error (${err.message}) — waiting ${(delay / 1000).toFixed(1)}s before retry ${attempt + 1}/${retries}`);
      await sleep(delay);
      attempt += 1;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { createClaudeClient, MODEL_DEFAULT };
