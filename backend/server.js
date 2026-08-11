/**
 * ============================================================
 * FILE: backend/server.js
 * OWNER: Person 2 (skeleton) + Person 4 (generate/refine)
 *
 * Express app. All WordPress + Claude calls are server-side.
 * Credentials live in the session (memory store for v1).
 *
 * ENV:
 *   PORT               default 8787
 *   FRONTEND_ORIGIN    e.g. https://app.example.com (CORS lock)
 *   SESSION_SECRET     any long random string
 *
 * NOTE: CommonJS. No "type":"module" needed in package.json.
 * ============================================================
 */

'use strict';

const express = require('express');
const session = require('express-session');
const cors = require('cors');

const wpClient = require('./wpClient');
const historyStore = require('./historyStore');
const componentStore = require('./componentStore');
const brandStore = require('./brandStore');
const proUsageStore = require('./proUsageStore');
const { startBackupScheduler } = require('./backupScheduler');
const { runPipeline, insertSectionWithFreshIds, upsertSectionByMatch } = require('./generatePipeline');
const { validateAndRepair } = require('./validator');
const { BRAND_KITS, getBrandKit } = require('./brandKits');
const { renderPage } = require('./previewRenderer');
const { STARTER_BRIEFS } = require('./starterBriefs');
const geminiImageClient = require('./geminiImageClient');

const app = express();
const PORT = process.env.PORT || 8787;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(express.json({ limit: '500mb' })); // effectively unlimited — images are client-optimized before upload
// Accept the configured origin plus its localhost/127.0.0.1 twin — some
// setups open the app via 127.0.0.1 and an exact-match string blocks them.
app.use(cors({
  origin: [...new Set([
    FRONTEND_ORIGIN,
    FRONTEND_ORIGIN.replace('//localhost', '//127.0.0.1'),
    FRONTEND_ORIGIN.replace('//127.0.0.1', '//localhost'),
  ])],
  credentials: true,
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
}));

/** Pull creds from session or throw a clean 401. */
function getCreds(req) {
  const c = req.session && req.session.creds;
  if (!c) {
    const e = new Error('Not connected. Submit credentials first.');
    e.status = 401;
    throw e;
  }
  return c;
}

/** ---------- Health ---------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

/** ---------- Connect: store creds + run the full test ---------- */
app.post('/api/connect/test', async (req, res) => {
  const {
    wpUrl, wpUser, wpAppPassword, claudeKey, claudeModel,
    allowPro, unsplashKey, geminiKey, brandContext,
  } = req.body || {};
  if (!wpUrl || !wpUser || !wpAppPassword || !claudeKey) {
    return res.status(400).json({ error: { code: 'missing_fields', message: 'All credential fields are required.' } });
  }

  const creds = { wpUrl, wpUser, wpAppPassword };
  try {
    const result = await wpClient.connectionTest(creds);
    // Persist only if the site is reachable and auth is valid.
    if (result.wpReachable && result.authValid) {
      req.session.creds = creds;
      req.session.claudeKey = claudeKey;
      req.session.claudeModel = claudeModel || undefined;
      req.session.connected = result.pluginInstalled && result.elementorActive;
      // v2 advanced options — default allowPro to whether Pro is active.
      req.session.allowPro = typeof allowPro === 'boolean' ? allowPro : !!result.elementorPro;
      req.session.unsplashKey = typeof unsplashKey === 'string' ? unsplashKey : '';
      req.session.geminiKey = typeof geminiKey === 'string' ? geminiKey : '';
      req.session.brandContext = typeof brandContext === 'string' ? brandContext : '';
    }
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: { code: err.code || 'test_failed', message: err.message } });
  }
});

/** ---------- Disconnect ---------- */
app.post('/api/disconnect', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/** ---------- Brand kits (no creds needed) ---------- */
app.get('/api/brand-kits', (_req, res) => {
  res.json(BRAND_KITS);
});

/** ---------- Starter briefs (no creds needed) ---------- */
app.get('/api/starter-briefs', (_req, res) => {
  res.json(STARTER_BRIEFS);
});

/** ---------- Preview: render page JSON to standalone HTML (no creds) ---------- */
app.post('/api/preview', (req, res) => {
  const pageJson = req.body && req.body.pageJson;
  if (!pageJson || typeof pageJson !== 'object') {
    return res.status(400).json({ error: { code: 'missing_page', message: 'pageJson is required.' } });
  }
  try {
    const device = ['desktop', 'tablet', 'mobile'].includes(req.body.device) ? req.body.device : 'desktop';
    const interactive = req.body.interactive === true;
    res.json({ html: renderPage(pageJson, { device, interactive }) });
  } catch (err) {
    res.status(500).json({ error: { code: 'preview_failed', message: err.message } });
  }
});


/** ---------- Section transplant: copy a section into another page ---------- */
app.post('/api/sections/copy', async (req, res) => {
  try {
    const creds = getCreds(req);
    const { targetPageId, sectionJson, index } = req.body || {};
    if (!targetPageId || !sectionJson || typeof sectionJson !== 'object') {
      return res.status(400).json({ error: { code: 'missing_fields', message: 'targetPageId and sectionJson are required.' } });
    }
    const allowPro = !!req.session.allowPro;

    // Sanitize the incoming section through the same validator as everything
    // else (single-element mode) — never trust raw client JSON.
    const validated = await validateAndRepair(JSON.stringify({
      title: 'transplant', content: [sectionJson], custom_css: '',
    }), { repairJson: async (t) => t }, { allowPro, containerize: false, cleanupAnchors: false });
    const section = validated.content[0];
    if (!section) {
      return res.status(400).json({ error: { code: 'bad_section', message: 'The section did not survive validation.' } });
    }

    // Fetch the live target page, insert, save back.
    const target = await wpClient.getPage(creds, targetPageId);
    const content = Array.isArray(target.elementor_data) ? target.elementor_data : [];
    // REPLACE the matching section when the target already has one (same
    // heading), otherwise ADD before the footer. Explicit index still wins.
    const placed = Number.isInteger(index)
      ? { mode: 'added', at: insertSectionWithFreshIds(content, section, index) }
      : upsertSectionByMatch(content, section);
    const at = placed.at;
    const saved = await wpClient.savePage(creds, {
      page_id: targetPageId,
      title: target.title,
      status: target.status || 'draft',
      elementor_data: content,
      page_settings: target.page_settings || { hide_title: 'yes' },
      custom_css: target.custom_css || '',
    });

    try {
      await historyStore.appendVersion(creds, targetPageId, {
        source: 'section-copy',
        title: target.title,
        summary: placed.mode === 'replaced'
          ? 'Replaced a section with the version from another variation'
          : 'Copied a section from another variation',
        pageJson: { title: target.title, page_settings: target.page_settings, content },
      });
    } catch (_) { /* history is best-effort */ }

    res.json({ ok: true, pageId: saved.id || targetPageId, insertedAt: at, mode: placed.mode, content });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'copy_failed', message: err.message } });
  }
});

/** ---------- Pages list (edit-mode dropdown) ---------- */
app.get('/api/pages', async (req, res) => {
  try {
    const pages = await wpClient.listPages(getCreds(req));
    res.json(pages);
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'list_failed', message: err.message } });
  }
});

/** ---------- Elementor globals (colors/fonts from the active kit) ---------- */
app.get('/api/globals', async (req, res) => {
  try {
    const data = await wpClient.getGlobals(getCreds(req));
    res.json({ available: true, ...data });
  } catch (err) {
    // A 404 from the plugin means an older EAI Connector without the
    // /globals route — not an error the user can act on beyond updating.
    if (err.status === 404) {
      return res.json({
        available: false,
        message: 'Update the EAI Connector plugin to use Elementor global colors/fonts.',
      });
    }
    res.status(err.status || 500).json({ error: { code: err.code || 'globals_failed', message: err.message } });
  }
});

/** ---------- Generation history (list / inspect / restore) ---------- */
app.get('/api/history', async (req, res) => {
  try {
    const creds = getCreds(req);
    const pageId = req.query.pageId;
    if (!pageId) {
      return res.status(400).json({ error: { code: 'missing_page_id', message: 'pageId is required.' } });
    }
    const versions = await historyStore.listVersions(creds, pageId);
    res.json({ versions });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'history_failed', message: err.message } });
  }
});

app.get('/api/history/version', async (req, res) => {
  try {
    const creds = getCreds(req);
    const { pageId, versionId } = req.query;
    if (!pageId || !versionId) {
      return res.status(400).json({ error: { code: 'missing_fields', message: 'pageId and versionId are required.' } });
    }
    const version = await historyStore.getVersion(creds, pageId, versionId);
    if (!version) {
      return res.status(404).json({ error: { code: 'version_not_found', message: 'No such version for this page.' } });
    }
    res.json({ version });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'history_failed', message: err.message } });
  }
});

app.post('/api/history/restore', async (req, res) => {
  try {
    const creds = getCreds(req);
    const { pageId, versionId } = req.body || {};
    if (!pageId || !versionId) {
      return res.status(400).json({ error: { code: 'missing_fields', message: 'pageId and versionId are required.' } });
    }
    const version = await historyStore.getVersion(creds, pageId, versionId);
    if (!version || !version.pageJson || !Array.isArray(version.pageJson.content)) {
      return res.status(404).json({ error: { code: 'version_not_found', message: 'No restorable version found.' } });
    }

    const pj = version.pageJson;
    // Republish the stored snapshot back onto the same page as a draft so
    // the user reviews the rollback before it goes live.
    const saved = await wpClient.savePage(creds, {
      title: pj.title,
      status: 'draft',
      elementor_data: pj.content,
      page_settings: pj.page_settings,
      custom_css: pj.custom_css,
      page_id: pageId,
    });

    // Record the restore itself as a new version (best-effort).
    try {
      await historyStore.appendVersion(creds, pageId, {
        source: 'refine',
        title: pj.title,
        summary: `Restored version ${versionId}`,
        pageJson: pj,
      });
    } catch (histErr) {
      console.warn('[history/restore] could not record restore version:', histErr.message);
    }

    const site = wpClient.normalizeSite(creds.wpUrl);
    res.json({
      pageId: saved.id,
      pageUrl: saved.link,
      editorUrl: saved.editor_link || `${site}/wp-admin/post.php?post=${saved.id}&action=elementor`,
      status: saved.status,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'restore_failed', message: err.message } });
  }
});

/** ---------- Component library (reusable saved blocks) ---------- */
app.get('/api/components', async (req, res) => {
  try {
    res.json({ components: await componentStore.listComponents(getCreds(req)) });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'components_failed', message: err.message } });
  }
});
app.post('/api/components', async (req, res) => {
  try {
    const { name, type, element } = req.body || {};
    const out = await componentStore.saveComponent(getCreds(req), { name, type, element });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'component_save_failed', message: err.message } });
  }
});
app.delete('/api/components/:id', async (req, res) => {
  try {
    const removed = await componentStore.deleteComponent(getCreds(req), req.params.id);
    res.json({ ok: removed });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'component_delete_failed', message: err.message } });
  }
});

/** ---------- Brand manager (saved brand guidelines, multi-brand) ---------- */
app.get('/api/brands', async (req, res) => {
  try {
    res.json({ brands: await brandStore.listBrands(getCreds(req)) });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'brands_failed', message: err.message } });
  }
});
app.post('/api/brands', async (req, res) => {
  try {
    const { name, palette, fonts, context, scope } = req.body || {};
    const out = await brandStore.saveBrand(getCreds(req), { name, palette, fonts, context, scope });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'brand_save_failed', message: err.message } });
  }
});
app.put('/api/brands/:id', async (req, res) => {
  try {
    const { name, palette, fonts, context, scope } = req.body || {};
    const ok = await brandStore.updateBrand(getCreds(req), req.params.id, { name, palette, fonts, context, scope });
    if (!ok) return res.status(404).json({ error: { code: 'not_found', message: 'Brand not found.' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'brand_update_failed', message: err.message } });
  }
});
app.delete('/api/brands/:id', async (req, res) => {
  try {
    const removed = await brandStore.deleteBrand(getCreds(req), req.params.id);
    res.json({ ok: removed });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'brand_delete_failed', message: err.message } });
  }
});

/** ---------- Pro-widget usage tracking (is Pro worth it?) ---------- */
app.get('/api/pro-usage', async (req, res) => {
  try {
    res.json(await proUsageStore.aggregateUsage(getCreds(req)));
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'usage_failed', message: err.message } });
  }
});

/** ---------- AI: which saved components fit this brief? ---------- */
app.post('/api/components/suggest', async (req, res) => {
  try {
    const creds = getCreds(req);
    const claudeKey = req.session.claudeKey;
    if (!claudeKey) return res.status(401).json({ error: { code: 'not_connected', message: 'Missing Claude API key.' } });
    const prompt = (req.body && req.body.prompt) || '';
    if (!String(prompt).trim()) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'prompt is required.' } });
    }
    const components = await componentStore.listComponents(creds);
    if (!components.length) return res.json({ picks: [] });

    const { createClaudeClient } = require('./claudeClient');
    const claude = createClaudeClient(claudeKey, req.session.claudeModel);
    const raw = await claude.suggestComponents({ prompt: String(prompt).slice(0, 4000), components });
    let picks = [];
    try {
      const parsed = JSON.parse(String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim());
      const validIds = new Set(components.map((c) => String(c.id)));
      if (parsed && Array.isArray(parsed.picks)) {
        picks = parsed.picks
          .filter((p) => p && validIds.has(String(p.id)))
          .slice(0, 5)
          .map((p) => ({ id: String(p.id), reason: typeof p.reason === 'string' ? p.reason : '' }));
      }
    } catch (_) { /* fall through with empty picks */ }
    res.json({ picks });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'suggest_components_failed', message: err.message } });
  }
});

/** ---------- Elementor Pro GLOBAL WIDGETS ---------- */
app.get('/api/global-widgets', async (req, res) => {
  try {
    const data = await wpClient.getGlobalWidgets(getCreds(req));
    res.json({ available: !!data.available, widgets: data.widgets || [], message: data.message });
  } catch (err) {
    if (err.status === 404) {
      // Older plugin without the route.
      return res.json({ available: false, widgets: [], message: 'Update the EAI Connector plugin (v1.3.0+) to use global widgets.' });
    }
    res.status(err.status || 500).json({ error: { code: err.code || 'global_widgets_failed', message: err.message } });
  }
});
app.post('/api/global-widgets', async (req, res) => {
  try {
    const creds = getCreds(req);
    const { componentId, title } = req.body || {};
    if (!componentId) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'componentId is required.' } });
    }
    const [component] = await componentStore.getComponents(creds, [componentId]);
    if (!component) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Saved component not found.' } });
    }
    const created = await wpClient.createGlobalWidget(creds, {
      title: title || component.name,
      element: component.element,
    });
    res.json({ id: created.id, title: created.title });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'global_widget_create_failed', message: err.message } });
  }
});

/** ---------- Site scanner (Playwright) ---------- */
app.post('/api/scan', async (req, res) => {
  try {
    getCreds(req); // auth only
    const url = req.body && req.body.url;
    // Lazy-require so the server boots fine when playwright isn't installed.
    let scanner;
    try {
      scanner = require('./scanner');
    } catch (e) {
      return res.status(503).json({ error: { code: 'scanner_unavailable', message: 'Site scanner is not installed on this machine.' } });
    }
    const out = await Promise.race([
      scanner.scanSite(url),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Scan timed out after 120s.'), { code: 'scan_timeout' })), 120000)),
    ]);
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'scan_failed', message: err.message } });
  }
});

/** ---------- Republish (section reorder / manual edits) ---------- */
app.post('/api/republish', async (req, res) => {
  try {
    const creds = getCreds(req);
    const { pageId, pageJson } = req.body || {};
    if (!pageId || !pageJson || !Array.isArray(pageJson.content)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'pageId and pageJson.content are required.' } });
    }
    // Validate structurally with NO model calls (repair stub throws).
    const stub = { repairJson: async () => { throw new Error('No model repair during republish.'); } };
    const page = await validateAndRepair(JSON.stringify(pageJson), stub, { allowPro: true, containerize: false });
    delete page._repairs;

    const saved = await wpClient.savePage(creds, {
      page_id: Number(pageId),
      title: page.title,
      status: 'draft',
      elementor_data: page.content,
      page_settings: page.page_settings,
      custom_css: page.custom_css,
    });
    try {
      await historyStore.appendVersion(creds, saved.id, {
        source: 'refine',
        title: page.title,
        summary: 'Manual section reorder / edit',
        pageJson: { title: page.title, page_settings: page.page_settings, content: page.content, custom_css: page.custom_css },
      });
    } catch (_) { /* history is best-effort */ }
    const site = wpClient.normalizeSite(creds.wpUrl);
    res.json({
      pageId: saved.id,
      pageUrl: saved.link,
      editorUrl: saved.editor_link || `${site}/wp-admin/post.php?post=${saved.id}&action=elementor`,
      status: saved.status,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'republish_failed', message: err.message } });
  }
});

/** ---------- AI improvement suggestions ---------- */
app.post('/api/suggest', async (req, res) => {
  try {
    getCreds(req);
    const claudeKey = req.session.claudeKey;
    if (!claudeKey) return res.status(401).json({ error: { code: 'not_connected', message: 'Missing Claude API key.' } });
    const { pageJson, prompt } = req.body || {};
    if (!pageJson || typeof pageJson !== 'object') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'pageJson is required.' } });
    }
    const { createClaudeClient } = require('./claudeClient');
    const claude = createClaudeClient(claudeKey, req.session.claudeModel);
    const raw = await claude.suggestImprovements({ pageJson, prompt: prompt || '' });
    let out = { suggestions: [] };
    try {
      const parsed = JSON.parse(String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim());
      if (parsed && Array.isArray(parsed.suggestions)) {
        out.suggestions = parsed.suggestions
          .filter((s) => s && typeof s.text === 'string')
          .slice(0, 6)
          .map((s) => ({ text: s.text, refinePrompt: typeof s.refinePrompt === 'string' ? s.refinePrompt : s.text }));
      }
    } catch (_) { /* fall through with empty suggestions */ }
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: { code: err.code || 'suggest_failed', message: err.message } });
  }
});

/** ---------- Generate (SSE progress stream) ---------- */
/**
 * POST /api/gemini/test — run ONE tiny real image generation so the user can
 * verify their Gemini key works BEFORE building a page. Returns the generated
 * image as a data URL for an instant visual preview.
 */
app.post('/api/gemini/test', async (req, res) => {
  const body = req.body || {};
  const key = (typeof body.geminiKey === 'string' ? body.geminiKey.trim() : '') ||
    req.session.geminiKey || '';
  if (!key) {
    return res.status(400).json({ ok: false, error: 'No Gemini API key provided.' });
  }
  try {
    const img = await geminiImageClient.generateImage(
      'a single fresh green apple on a clean white studio background', key);
    if (img && img.buffer && img.buffer.length) {
      req.session.geminiKey = key; // a proven key becomes the session default
      return res.json({
        ok: true,
        bytes: img.buffer.length,
        mime: img.mime,
        preview: `data:${img.mime};base64,${img.buffer.toString('base64')}`,
      });
    }
    return res.json({
      ok: false,
      error: 'The API returned no image — the key may be invalid, out of quota, or image generation may be unavailable for it.',
    });
  } catch (e) {
    return res.json({ ok: false, error: `Test failed: ${(e && e.message) || 'unknown error'}` });
  }
});

app.post('/api/generate', async (req, res) => {
  await handleGenerate(req, res, false);
});

/** ---------- Refine (same as generate, edit an existing result) ---------- */
app.post('/api/refine', async (req, res) => {
  await handleGenerate(req, res, true);
});

async function handleGenerate(req, res, isRefine) {
  let creds, claudeKey, claudeModel;
  try {
    creds = getCreds(req);
    claudeKey = req.session.claudeKey;
    claudeModel = req.session.claudeModel;
    if (!claudeKey) throw Object.assign(new Error('Missing Claude API key.'), { status: 401 });
  } catch (err) {
    return res.status(err.status || 401).json({ error: { code: 'not_connected', message: err.message } });
  }

  // Set up Server-Sent Events.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data || {})}\n\n`);
  };

  const body = req.body || {};
  const {
    mode = 'new', pageId, prompt, previousJson, refinePrompt,
    images = [], template = 'canvas', title, status = 'draft',
  } = body;

  // For refine, treat it as an edit against the previous result.
  const effectivePrompt = isRefine ? (refinePrompt || prompt) : prompt;

  // Header policy: 'none' (default — the theme already has a header),
  // 'temporary' (logo text + one CTA), or 'full' (real nav-menu when Pro).
  const includeHeader = ['none', 'temporary', 'full'].includes(body.includeHeader)
    ? body.includeHeader
    : 'none';

  // Section-scoped refine: regenerate ONLY this element and splice it back —
  // everything else on the freshly fetched page passes through untouched.
  const sectionId = typeof body.sectionId === 'string' && body.sectionId.trim()
    ? body.sectionId.trim()
    : null;

  // v2 advanced options — a NON-EMPTY body value overrides the session,
  // the session provides defaults. An empty string is treated as absent:
  // the refine UI posts '' for fields the user never touched, and letting
  // '' override the session silently dropped unsplashKey/imageMode on
  // /api/refine (so the images stage never ran with the connected key).
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  const allowPro = typeof body.allowPro === 'boolean'
    ? body.allowPro
    : !!req.session.allowPro;
  const brandContext = nonEmpty(body.brandContext)
    ? body.brandContext
    : (req.session.brandContext || '');
  const brandKit = body.brandKit ? getBrandKit(body.brandKit) : null;
  const autoRefine = !!body.autoRefine;
  const unsplashKey = nonEmpty(body.unsplashKey)
    ? body.unsplashKey
    : (req.session.unsplashKey || '');
  const imageMode = nonEmpty(body.imageMode)
    ? body.imageMode
    : (req.session.imageMode || 'auto');
  const geminiKey = nonEmpty(body.geminiKey)
    ? body.geminiKey
    : (req.session.geminiKey || '');

  // Remember explicitly-chosen values so a later /api/refine (which often
  // sends a minimal body) inherits them via the session fallback above.
  if (nonEmpty(body.imageMode)) req.session.imageMode = body.imageMode;
  if (nonEmpty(body.unsplashKey)) req.session.unsplashKey = body.unsplashKey;
  if (nonEmpty(body.geminiKey)) req.session.geminiKey = body.geminiKey;
  if (nonEmpty(body.brandContext)) req.session.brandContext = body.brandContext;

  // Elementor globals as the brand kit (opt-in). Best-effort: on any
  // failure we just generate without them.
  let globalKit = null;
  if (body.useGlobals === true) {
    try {
      const globals = await wpClient.getGlobals(creds);
      globalKit = buildGlobalKit(globals);
    } catch (err) {
      console.warn('[generate] useGlobals: could not fetch Elementor globals, skipping:', err.message);
    }
  }

  // Saved brand (brand manager): its palette/fonts act as the kit (a
  // globals kit loses to a saved brand; an explicit preset brandKit wins),
  // and its context text is appended to the brand context. Best-effort.
  let savedBrandKit = null;
  let effectiveBrandContext = brandContext;
  if (nonEmpty(body.brandId)) {
    try {
      const saved = await brandStore.getBrand(creds, body.brandId);
      if (saved) {
        if (saved.palette || saved.fonts) {
          savedBrandKit = {
            id: `brand-${saved.id}`,
            name: saved.name,
            palette: saved.palette || {},
            fonts: saved.fonts || {},
          };
        }
        if (saved.context) {
          effectiveBrandContext = effectiveBrandContext
            ? `${effectiveBrandContext}\n${saved.context}`
            : saved.context;
        }
      }
    } catch (err) {
      console.warn('[generate] brandId: could not load saved brand, skipping:', err.message);
    }
  }

  // Component library: load the full elements for the requested ids so the
  // pipeline can hand them to the model as proven reusable blocks.
  let reuseComponents = [];
  if (Array.isArray(body.componentIds) && body.componentIds.length) {
    try {
      reuseComponents = await componentStore.getComponents(creds, body.componentIds.slice(0, 10));
    } catch (err) {
      console.warn('[generate] componentIds: could not load components, skipping:', err.message);
    }
  }

  // Site global widgets (opt-in): let the model embed the site's existing
  // Elementor Pro global widgets. Best-effort — skipped on any failure.
  let availableGlobalWidgets = [];
  if (body.useGlobalWidgets === true && allowPro) {
    try {
      const gw = await wpClient.getGlobalWidgets(creds);
      if (gw && gw.available && Array.isArray(gw.widgets)) {
        availableGlobalWidgets = gw.widgets.slice(0, 30);
      }
    } catch (err) {
      console.warn('[generate] useGlobalWidgets: could not load global widgets, skipping:', err.message);
    }
  }

  let lastStage = null;
  try {
    const out = await runPipeline({
      creds,
      claudeKey,
      claudeModel,
      mode: isRefine ? 'edit' : mode,
      pageId: isRefine ? (pageId || (previousJson && previousJson.pageId)) : pageId,
      prompt: effectivePrompt,
      images,
      template,
      title,
      status,
      allowPro,
      brandContext: effectiveBrandContext,
      brandKit: brandKit || savedBrandKit,
      globalKit,
      reuseComponents,
      availableGlobalWidgets,
      autoRefine,
      unsplashKey,
      imageMode,
      geminiKey,
      sectionId,
      includeHeader,
      variationMode: !!body.variationMode,
    }, (stage, extra) => {
      if (stage === 'done') {
        send('done', extra);
      } else {
        // Always send on stage CHANGE; detail updates may repeat the same
        // stage (e.g. 'generating' with '38,400 chars written').
        lastStage = stage;
        const payload = { stage };
        if (extra && extra.detail) payload.detail = extra.detail;
        send('progress', payload);
      }
    });

    // out already emitted via 'done'
    res.end();
  } catch (err) {
    // Log the precise failure server-side so we never have to guess which step
    // (generating / validating / images / publishing) or endpoint broke.
    console.error(`[${isRefine ? 'refine' : 'generate'}] failed at stage "${lastStage || 'startup'}":`, err && err.stack ? err.stack : err);
    send('error', {
      code: err.code || 'generate_failed',
      step: lastStage || 'startup',
      message: err.message,
      rawOutput: err.rawOutput || undefined, // let the UI offer a raw download
    });
    res.end();
  }
}

/**
 * Build a compact brand-kit-like object from the plugin's /globals payload
 * ({ system_colors, custom_colors, system_typography, custom_typography }).
 * Palette keys come from each entry's title (lowercased) — Elementor's
 * defaults are Primary / Secondary / Text / Accent — plus any custom
 * colors, capped at ~8. Returns null when the kit has nothing usable.
 */
function buildGlobalKit(globals) {
  if (!globals || typeof globals !== 'object') return null;

  const slug = (s, fallback) => {
    const k = String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return k || fallback;
  };

  const palette = {};
  const colors = []
    .concat(Array.isArray(globals.system_colors) ? globals.system_colors : [])
    .concat(Array.isArray(globals.custom_colors) ? globals.custom_colors : [])
    .filter((c) => c && typeof c.color === 'string' && c.color)
    .slice(0, 8);
  colors.forEach((c, i) => {
    let key = slug(c.title, `color_${i + 1}`);
    while (key in palette) key += '_'; // never drop a color on a title clash
    palette[key] = c.color;
  });

  const fonts = {};
  const typos = []
    .concat(Array.isArray(globals.system_typography) ? globals.system_typography : [])
    .concat(Array.isArray(globals.custom_typography) ? globals.custom_typography : [])
    .filter((t) => t && typeof t.typography_font_family === 'string' && t.typography_font_family)
    .slice(0, 8);
  typos.forEach((t, i) => {
    let key = slug(t.title, `font_${i + 1}`);
    while (key in fonts) key += '_';
    fonts[key] = t.typography_font_weight
      ? `${t.typography_font_family} (weight ${t.typography_font_weight})`
      : t.typography_font_family;
  });
  // Convenience aliases the model already understands from preset kits:
  // Elementor's "Primary" typography styles headings, "Text" styles body copy.
  if (!fonts.heading) {
    const heading = typos.find((t) => /primary/i.test(t.title || '')) || typos[0];
    if (heading) fonts.heading = heading.typography_font_family;
  }
  if (!fonts.body) {
    const body = typos.find((t) => /text|body/i.test(t.title || '')) || typos[typos.length - 1];
    if (body) fonts.body = body.typography_font_family;
  }

  if (Object.keys(palette).length === 0 && Object.keys(fonts).length === 0) return null;

  return {
    id: 'elementor-globals',
    name: 'Elementor Global Colors & Fonts (site kit)',
    palette,
    fonts,
  };
}

/** ---------- Global JSON error fallback ---------- */
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: { code: err.code || 'server_error', message: err.message } });
});

app.listen(PORT, () => {
  console.log(`EAI backend listening on :${PORT} (frontend origin: ${FRONTEND_ORIGIN})`);
  // Daily zip backups of all app data (history/components/brands). Never fatal.
  try {
    startBackupScheduler();
  } catch (err) {
    console.warn('Backup scheduler failed to start (non-fatal):', err.message);
  }
});
