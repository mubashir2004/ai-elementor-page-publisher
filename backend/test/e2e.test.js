/**
 * ============================================================
 * FILE: backend/test/e2e.test.js
 * OWNER: Person 10 (QA)
 *
 * Exercises the REAL pipeline (generatePipeline -> claudeClient ->
 * validator -> wpClient) end to end, but intercepts global fetch
 * so it runs OFFLINE and deterministically. No API key, no site.
 *
 * Run:  cd backend && node --test
 * ============================================================
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { runPipeline } = require('../generatePipeline');
const { samplePage, samplePageWithPro, sampleDesignSystem } = require('./mockClaude');

const CREDS = { wpUrl: 'https://example.com', wpUser: 'admin', wpAppPassword: 'pw' };

// A tiny valid 1x1 transparent PNG, base64-encoded — stands in for a
// Gemini-generated image without needing any real bytes.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Install a fetch mock that routes by URL + body. Returns a restore fn. */
function mockFetch({ savedPages = [], proWidget = false, splicedElement = null, generatedPage = null, designSystem = null } = {}) {
  const realFetch = globalThis.fetch;
  const calls = { sideload: 0, save: 0, generate: 0, extract: 0, getPage: 0, refine: 0, gemini: 0, media: 0, spliceRefine: 0, template: 0 };
  const saveBodies = []; // capture what was published for splice assertions

  globalThis.fetch = async (url, options = {}) => {
    // Most callers send a JSON string body, but wpClient.uploadMedia sends a
    // raw Buffer (the image bytes) — never try to JSON.parse that.
    let body = {};
    if (typeof options.body === 'string') {
      try { body = JSON.parse(options.body); } catch (_) { body = {}; }
    }

    // ---- Gemini (Google Generative Language API) ----
    if (url.includes('generativelanguage.googleapis.com')) {
      calls.gemini++;
      return jsonRes({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here is your image.' },
                { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
              ],
            },
          },
        ],
      });
    }

    // ---- WordPress: core media upload (used by uploadMedia for Gemini images) ----
    if (url.includes('/wp/v2/media')) {
      calls.media++;
      return jsonRes({
        id: 700 + calls.media,
        source_url: 'https://example.com/wp-content/uploads/gen.png',
      });
    }

    // ---- Anthropic ----
    if (url.includes('api.anthropic.com')) {
      const content = body.messages && body.messages[0] && body.messages[0].content;
      // Both the design-extraction pass AND generation-with-a-reference-image
      // now send array content (image blocks + text). Discriminate on the text:
      // only extraction carries the "Extract the design system" instruction.
      const textOf = Array.isArray(content)
        ? ((content.find((c) => c && c.type === 'text') || {}).text || '')
        : String(content || '');
      const hasImage = Array.isArray(content) && content.some((c) => c && c.type === 'image');

      if (hasImage && /extract the design system/i.test(textOf)) {
        calls.extract++;
        return jsonRes({ content: [{ type: 'text', text: JSON.stringify(designSystem || sampleDesignSystem()) }] });
      }
      // refineElement() (section splice) opens with 'Here is ONE Elementor element'.
      if (textOf.includes('ONE Elementor element')) {
        calls.spliceRefine++;
        return jsonRes({ content: [{ type: 'text', text: JSON.stringify(splicedElement || samplePage().content[0]) }] });
      }
      // critiquePage() opens its user message with 'ORIGINAL BRIEF:'.
      if (textOf.includes('ORIGINAL BRIEF')) {
        calls.refine++;
        // Return the same (still valid) page shape the generate pass produced.
        const refined = proWidget ? samplePageWithPro('E2E Page') : samplePage('E2E Page');
        return jsonRes({ content: [{ type: 'text', text: JSON.stringify(refined) }] });
      }
      // Generation pass (prompt-only OR with a reference image attached).
      calls.generate++;
      const generated = generatedPage || (proWidget ? samplePageWithPro('E2E Page') : samplePage('E2E Page'));
      return jsonRes({ content: [{ type: 'text', text: JSON.stringify(generated) }] });
    }

    // ---- WordPress: eai/v1 ----
    if (url.includes('/wp-json/eai/v1/media/sideload')) {
      calls.sideload++;
      return jsonRes({ id: 900 + calls.sideload, url: `https://example.com/wp-content/uploads/img-${calls.sideload}.jpg` });
    }
    if (url.includes('/wp-json/eai/v1/pages/')) {
      calls.getPage++;
      const existing = savedPages[0] || samplePage('Existing');
      return jsonRes({
        id: 42, title: existing.title, status: 'draft',
        elementor_data: existing.content, page_settings: existing.page_settings, custom_css: '',
        link: 'https://example.com/existing',
      });
    }
    if (url.endsWith('/wp-json/eai/v1/templates')) {
      calls.template++;
      return jsonRes({ id: 555, title: body.title || 'EAI Loop Card', type: body.type || 'loop-item' });
    }
    if (url.endsWith('/wp-json/eai/v1/pages')) {
      calls.save++;
      saveBodies.push(body);
      const id = body.page_id || 123;
      return jsonRes({ ok: true, id, link: `https://example.com/?p=${id}`,
        editor_link: `https://example.com/wp-admin/post.php?post=${id}&action=elementor`, status: body.status });
    }

    throw new Error('Unexpected fetch in test: ' + url);
  };

  return { restore: () => { globalThis.fetch = realFetch; }, calls, saveBodies };
}

function jsonRes(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(obj); },
    async json() { return obj; },
  };
}

test('E2E: prompt-only new page publishes and returns links', async () => {
  const m = mockFetch();
  const stages = [];
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'A clean SaaS landing page', images: [], template: 'canvas', status: 'draft',
    }, (s) => stages.push(s));

    assert.ok(out.pageId, 'returns a page id');
    assert.match(out.editorUrl, /action=elementor/);
    assert.match(out.pageUrl, /example\.com/);
    assert.equal(m.calls.generate, 1, 'called generate once');
    assert.equal(m.calls.extract, 0, 'no image pass without images');
    assert.equal(m.calls.save, 1, 'saved once');
    // progress stages arrived in order (the sample page has an external image, so the 'images' sideload stage fires)
    assert.deepEqual(stages.filter((s) => s !== 'done'), ['generating', 'validating', 'images', 'publishing']);
  } finally {
    m.restore();
  }
});

test('E2E: with images runs the design pass first and sideloads', async () => {
  const m = mockFetch();
  const stages = [];
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'Match this mockup',
      images: [{ base64: 'AAAA', mediaType: 'image/png' }],
      template: 'canvas',
    }, (s) => stages.push(s));

    assert.equal(m.calls.extract, 1, 'ran design extraction (Pass 1)');
    assert.equal(m.calls.generate, 1, 'ran page generation (Pass 2)');
    assert.ok(m.calls.sideload >= 1, 'sideloaded at least one image');
    assert.equal(stages[0], 'analyzing', 'analyzing stage came first');
    assert.ok(out.pageId);
  } finally {
    m.restore();
  }
});

test('E2E: edit mode reads existing page and updates same id', async () => {
  const existing = samplePage('Old Title');
  const m = mockFetch({ savedPages: [existing] });
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'edit', pageId: 42,
      prompt: 'change the heading', images: [], template: 'default',
    }, () => {});
    assert.equal(m.calls.getPage, 1, 'fetched the existing page');
    assert.equal(out.pageId, 42, 'updated the same page id');
  } finally {
    m.restore();
  }
});

test('E2E: autoRefine runs the critique pass and still publishes', async () => {
  const m = mockFetch();
  const stages = [];
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'A clean SaaS landing page', images: [], template: 'canvas',
      autoRefine: true,
    }, (s) => stages.push(s));

    assert.equal(m.calls.generate, 1, 'generated once');
    assert.equal(m.calls.refine, 1, 'ran the self-critique refine pass once');
    assert.ok(stages.includes('autorefine'), 'emitted the dedicated autorefine stage');
    // autorefine must come after validating and before publishing.
    assert.ok(stages.indexOf('autorefine') > stages.indexOf('validating'), 'autorefine follows validating');
    assert.ok(stages.indexOf('autorefine') < stages.indexOf('publishing'), 'autorefine precedes publishing');
    assert.equal(m.calls.save, 1, 'still published exactly once');
    assert.ok(out.pageId, 'returns a page id');
  } finally {
    m.restore();
  }
});

test('E2E: allowPro keeps a Pro widget through the pipeline', async () => {
  const m = mockFetch({ proWidget: true });
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'A contact page with a form', images: [], template: 'canvas',
      allowPro: true,
    }, () => {});

    const json = JSON.stringify(out.rawJson);
    assert.ok(json.includes('"widgetType":"form"'), 'Pro form widget survived validation with allowPro');
    assert.ok(out.pageId, 'still published');
  } finally {
    m.restore();
  }
});

test('E2E: without allowPro a Pro widget is dropped', async () => {
  const m = mockFetch({ proWidget: true });
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'A contact page with a form', images: [], template: 'canvas',
      // allowPro omitted -> defaults to false
    }, () => {});

    const json = JSON.stringify(out.rawJson);
    assert.ok(!json.includes('"widgetType":"form"'), 'Pro form widget dropped when Pro is not allowed');
    assert.ok(out.pageId, 'still published');
  } finally {
    m.restore();
  }
});

test('E2E: sideloaded images get real ids swapped into the JSON', async () => {
  const m = mockFetch();
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'landing page', images: [], template: 'canvas',
    }, () => {});
    // Find the image widget in the returned JSON — its id should no longer be empty.
    const json = JSON.stringify(out.rawJson);
    assert.ok(json.includes('/wp-content/uploads/img-'), 'image url swapped to media library url');
  } finally {
    m.restore();
  }
});

test('E2E: imageMode gemini generates images and uploads them to WP media', async () => {
  const m = mockFetch();
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new',
      prompt: 'A clean SaaS landing page', images: [], template: 'canvas',
      imageMode: 'gemini', geminiKey: 'gem-test',
    }, () => {});
    assert.ok(m.calls.gemini >= 1, 'called the Gemini image API');
    assert.ok(m.calls.media >= 1, 'uploaded at least one image to WP core media');
    const firstImg = findFirstImage(out.rawJson.content);
    assert.ok(firstImg, 'page has an image');
    assert.match(firstImg.url, /uploads\/gen\.png/);
    assert.ok(Number(firstImg.id) >= 700, 'image carries the uploaded WP attachment id');
  } finally {
    m.restore();
  }
});

test('E2E: sectionId refine splices only the target element, others pass byte-identical', async () => {
  const heading = (id, title) => ({
    id, elType: 'widget', widgetType: 'heading', settings: { title }, elements: [],
  });
  const secA = {
    id: 'seca001', elType: 'container', isInner: false,
    settings: { flex_direction: 'column', background_color: '#ffffff' },
    elements: [heading('hedaa01', 'Untouched section')],
  };
  const secB = {
    id: 'secb001', elType: 'container', isInner: false,
    settings: { flex_direction: 'column' },
    elements: [heading('hedbb01', 'Old heading')],
  };
  const existing = {
    title: 'Two Sections',
    page_settings: { hide_title: 'yes' },
    content: [secA, secB],
    custom_css: '',
  };
  // What the (mock) model returns for the section refine: same element, new copy.
  const updatedB = {
    id: 'secb001', elType: 'container', isInner: false,
    settings: { flex_direction: 'column' },
    elements: [heading('hedbb01', 'Updated heading')],
  };
  // Snapshot BEFORE the run — proves the untouched section survives byte-identical.
  const secASnapshot = JSON.parse(JSON.stringify(secA));

  const m = mockFetch({ savedPages: [existing], splicedElement: updatedB });
  const stages = [];
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'edit', pageId: 42,
      sectionId: 'secb001', prompt: 'Change the heading to "Updated heading"',
      images: [], template: 'default',
    }, (s) => stages.push(s));

    assert.equal(m.calls.getPage, 1, 'fetched the live page');
    assert.equal(m.calls.spliceRefine, 1, 'called the focused element refine');
    assert.equal(m.calls.generate, 0, 'did NOT run a whole-page generation');
    assert.equal(m.calls.save, 1, 'published once');
    assert.equal(out.pageId, 42, 'updated the same page id');

    assert.equal(out.rawJson.content.length, 2, 'both sections survive');
    assert.deepEqual(out.rawJson.content[0], secASnapshot,
      'the untouched section passed through byte-identical');
    assert.equal(out.rawJson.content[1].id, 'secb001', 'spliced element keeps its id');
    assert.equal(out.rawJson.content[1].elements[0].settings.title, 'Updated heading');

    // The published payload carries the FULL spliced content.
    assert.equal(m.saveBodies[0].elementor_data.length, 2);
    assert.deepEqual(m.saveBodies[0].elementor_data[0], secASnapshot);

    // Same stage names as a normal run (no analyzing/refining; no images work here).
    assert.deepEqual(stages.filter((s) => s !== 'done'), ['generating', 'validating', 'publishing']);
  } finally {
    m.restore();
  }
});

test('E2E: sectionId that does not exist falls back to a whole-page refine', async () => {
  const existing = samplePage('Fallback Page');
  const m = mockFetch({ savedPages: [existing] });
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'edit', pageId: 42,
      sectionId: 'nope999', prompt: 'change the heading',
      images: [], template: 'default',
    }, () => {});

    assert.equal(m.calls.spliceRefine, 0, 'no focused refine for a missing id');
    assert.equal(m.calls.generate, 1, 'fell back to the whole-page path');
    assert.ok(out.repairs.some((r) => /not found/i.test(r)), 'fallback note recorded');
    assert.equal(out.pageId, 42);
  } finally {
    m.restore();
  }
});

function findFirstImage(nodes) {
  for (const n of nodes || []) {
    const s = n.settings || {};
    if (s.image && typeof s.image === 'object' && s.image.url) return s.image;
    const nested = findFirstImage(n.elements);
    if (nested) return nested;
  }
  return null;
}

test('E2E: blog page with reference upgrades posts widget to a loop-grid + LIVE filter (full pipeline)', async () => {
  // A generated page whose blog band uses the posts widget.
  const blogPage = samplePageWithPro('Loop E2E');
  blogPage.content.push({
    id: 'blgband1', elType: 'container', isInner: false, settings: {},
    elements: [
      { id: 'blghd01', elType: 'widget', widgetType: 'heading', settings: { title: 'From Our Blog' }, elements: [] },
      { id: 'blgpst1', elType: 'widget', widgetType: 'posts',
        settings: { _skin: 'classic', classic_columns: '3', classic_posts_per_page: 3 }, elements: [] },
    ],
  });
  // Design system whose text triggers the filter-pill detection.
  const ds = sampleDesignSystem();
  ds.sections = (ds.sections || []).concat(['Blog: filter tabs (All Posts | Tips) above a 3-col post grid with dates']);

  const m = mockFetch({ generatedPage: blogPage, designSystem: ds });
  try {
    const out = await runPipeline({
      creds: CREDS, claudeKey: 'sk-test', mode: 'new', allowPro: true,
      prompt: 'Roofing site with blog', template: 'canvas', status: 'draft',
      images: [{ base64: TINY_PNG_B64, mediaType: 'image/png' }],
      imageMode: 'stock',
    }, () => {});

    assert.ok(out.pageId, 'page still publishes');
    assert.equal(m.calls.template, 1, 'ONE loop-item template was created on the site');
    const saved = JSON.stringify(m.saveBodies[m.saveBodies.length - 1]);
    assert.ok(saved.includes('"loop-grid"'), 'posts widget was swapped for the loop-grid');
    assert.ok(saved.includes('"template_id":555'), 'grid points at the created template');
    assert.ok(saved.includes('"taxonomy-filter"'), 'live filter bar was added (reference showed filter pills)');
    assert.ok(!/"widgetType":"posts"/.test(saved), 'the old posts widget is gone');
  } finally {
    m.restore();
  }
});
