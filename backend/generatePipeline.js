/**
 * ============================================================
 * FILE: backend/generatePipeline.js
 * OWNER: Person 4 (orchestrator) + Person 7 (media sideload swap)
 *
 * The two-pass chain end to end:
 *   Pass 1 (if images) -> design system
 *   Pass 2             -> page JSON
 *   validate + repair
 *   (optional) sideload external images -> swap {id,url}
 *   publish to WordPress
 *
 * `onStage(stageName, extra?)` is called so /api/generate can
 * stream progress over SSE.
 * ============================================================
 */

'use strict';

const { createClaudeClient } = require('./claudeClient');
const { validateAndRepair, lenientParseJson, enforceHeaderRows, dedupeHeaderBands, dedupeTopbarStrips, shortId } = require('./validator');
const unsplashClient = require('./unsplashClient');
const geminiImageClient = require('./geminiImageClient');
const wpClient = require('./wpClient');
const historyStore = require('./historyStore');
const { buildProReport } = require('./proReport');
const proUsageStore = require('./proUsageStore');
const { optimizeImage } = require('./imageOptimizer');


// ------------------------------------------------------------------
// DESIGN-SYSTEM CACHE: 3 parallel variations analyze the SAME reference
// images — one extraction serves all of them. Keyed by an image-content
// hash; short TTL; tiny LRU. Concurrent misses share ONE in-flight call.
// ------------------------------------------------------------------
const crypto = require('crypto');
const DS_CACHE = new Map(); // hash -> { promise, at }
const DS_TTL_MS = 15 * 60 * 1000;
function dsCacheKey(images) {
  const h = crypto.createHash('sha1');
  for (const img of images) h.update(String(img.base64 || '').slice(0, 4096)).update(String((img.base64 || '').length));
  return h.digest('hex');
}
function dsCacheGetOrCreate(key, factory) {
  const now = Date.now();
  for (const [k, v] of DS_CACHE) if (now - v.at > DS_TTL_MS) DS_CACHE.delete(k);
  const hit = DS_CACHE.get(key);
  if (hit) return hit.promise;
  const promise = factory().catch((err) => { DS_CACHE.delete(key); throw err; });
  DS_CACHE.set(key, { promise, at: now });
  if (DS_CACHE.size > 8) DS_CACHE.delete(DS_CACHE.keys().next().value);
  return promise;
}

const EDITOR_LINK = (site, id) =>
  `${site.replace(/\/+$/, '')}/wp-admin/post.php?post=${id}&action=elementor`;

// HEADER POLICY — appended to the generation prompt. The generated page lives
// inside an existing theme, so by default the model must NOT build a header.
const HEADER_DIRECTIVES = {
  none:
    '\n\nHEADER: Do NOT create any header/top-navigation section — the site ' +
    'already has its own header. Start the page directly with the hero.',
  temporary:
    '\n\nHEADER: add only a minimal temporary header (logo text + one CTA ' +
    'button). No menu links. The header band container MUST carry ' +
    'html_tag:"header".',
  full:
    '\n\nHEADER: build a full header. If Pro widgets are available the real ' +
    'nav-menu widget is MANDATORY for the navigation — a full header without ' +
    'the nav-menu widget is a FAILURE (never an icon-list text menu, never ' +
    'plain heading links). It is natively mobile-friendly (hamburger). ' +
    'The header band container MUST carry html_tag:"header". ' +
    'BUILD THE HEADER EXACTLY from design_system.header when present: one ROW ' +
    'per tier in order (a topbar utility strip is its OWN row above the main ' +
    'bar), each tier with its EXACT sampled background color (tiers often ' +
    'differ — e.g. red strip over a black main bar), each tier\'s left/center/' +
    'right contents in place (phone/email/socials/links/badges in the tier the ' +
    'reference shows them), and the CTA with its VERBATIM label and style — ' +
    'never substitute a phone pill unless the reference main bar shows one. ' +
    'MOBILE: each tier stays one row (flex_wrap_mobile:"nowrap", header ' +
    'widgets _element_width:"auto"); the CTA stays VISIBLE — never hide_mobile.',
};

/**
 * Wrap the caller's onStage with per-stage timing: each time the stage NAME
 * changes, log how long the previous stage took. Repeated calls with the same
 * stage (progress-detail updates) pass through without resetting the clock.
 */
function makeStageEmitter(onStage) {
  let current = null;
  let startedAt = 0;
  return (stage, extra) => {
    if (stage !== current) {
      const now = Date.now();
      if (current && current !== 'done') {
        console.log(`[timing] ${current} took ${((now - startedAt) / 1000).toFixed(1)}s`);
      }
      current = stage;
      startedAt = now;
    }
    onStage(stage, extra);
  };
}


/**
 * @param {Object} params
 *   creds            { wpUrl, wpUser, wpAppPassword }
 *   claudeKey        string
 *   claudeModel      string
 *   mode             'new' | 'edit'
 *   pageId           number (edit mode)
 *   prompt           string
 *   images           [{ base64, mediaType }]
 *   template         'canvas' | 'full_width' | 'default'
 *   title            string
 *   status           'draft' | 'publish'
 *   sideloadImages   boolean (default true)
 *   allowPro         boolean (Pro widgets allowed; default false)
 *   brandContext     string  (freeform brand/guardrail text; default '')
 *   brandKit         object|null (resolved brand-kit preset)
 *   globalKit        object|null (brand-kit-like object built from the
 *                    site's Elementor global colors/fonts; used as the
 *                    brand kit ONLY when no explicit brandKit was chosen)
 *   unsplashKey      string  (Unsplash Access Key; default '')
 *   autoRefine       boolean (run the self-critique refine pass)
 *   sectionId        string|null (edit mode: refine ONLY this top-level
 *                    element and splice it back — every other element passes
 *                    through byte-identical)
 *   includeHeader    'none' | 'temporary' | 'full' (header policy; default
 *                    'none' — the site theme already provides a header)
 * @param {Function} onStage(stage, extra) — extra.detail carries progress
 *                   detail (e.g. '38,400 chars written'); detail updates may
 *                   repeat the current stage name.
 */
// Representative spread of reference images for the visual correction pass:
// everything when the set is small (uploaded mockups), an even head-to-tail
// sample when it's a long scan (24 viewport segments) — first and last always
// included so header and footer are both visible to the critique.
function sampleImagesForCritique(images, max = 12) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length <= max) return images;
  const out = [];
  for (let i = 0; i < max; i++) {
    out.push(images[Math.round((i * (images.length - 1)) / (max - 1))]);
  }
  return out;
}

async function runPipeline(params, onStage = () => {}) {
  const {
    creds, claudeKey, claudeModel, claudeUseCli = false, mode = 'new', pageId,
    prompt, images = [], template = 'canvas', title,
    status = 'draft', sideloadImages = true,
    allowPro = false, brandContext = '', brandKit = null,
    globalKit = null, reuseComponents = [], availableGlobalWidgets = [],
    unsplashKey = '', autoRefine = false,
    imageMode = 'auto', geminiKey = '',
    sectionId = null, includeHeader = 'none',
    variationMode = false,
  } = params;

  // Stage emitter: same callback surface, plus per-stage timing logs.
  const emit = makeStageEmitter(onStage);

  // Section-refine intent: an edit scoped to ONE element. Confirmed against
  // the freshly fetched page below; when confirmed we take the SPLICE branch
  // (skip the design pass — the instruction targets one existing element).
  const spliceIntent = mode === 'edit' && !!sectionId;

  // Component library: hand saved blocks to the model as proven building
  // material — reuse them where they fit, with fresh ids and adapted copy.
  let effectivePrompt = prompt;
  if (Array.isArray(reuseComponents) && reuseComponents.length) {
    effectivePrompt = (prompt || '') +
      '\n\n<reusable_components>\n' +
      'The user saved these proven blocks. REUSE them where they fit the layout ' +
      '(adapt the copy to this business, regenerate every id to fresh unique ' +
      '7-char ids, keep the styling):\n' +
      JSON.stringify(reuseComponents.map((c) => ({ name: c.name, type: c.type, element: c.element }))) +
      '\n</reusable_components>';
  }

  // Site global widgets (Elementor Pro): the model may embed them where they
  // genuinely fit. They auto-sync across every page that uses them.
  if (allowPro && Array.isArray(availableGlobalWidgets) && availableGlobalWidgets.length) {
    effectivePrompt = (effectivePrompt || '') +
      '\n\n<site_global_widgets>\n' +
      'This site has these Elementor GLOBAL WIDGETS (they auto-update everywhere ' +
      'when edited once). Where one genuinely fits (shared CTA, contact block, ' +
      'badge row…), embed it EXACTLY as: ' +
      '{"id":"<fresh 7-char id>","elType":"widget","widgetType":"global","templateID":<id>,"settings":{},"elements":[]} ' +
      '— never invent template ids, never use one that does not fit:\n' +
      availableGlobalWidgets.map((w) => `${w.id} | ${w.title}`).join('\n') +
      '\n</site_global_widgets>';
  }

  // HEADER POLICY — always appended (default 'none' actively forbids a header).
  effectivePrompt = (effectivePrompt || '') +
    (HEADER_DIRECTIVES[includeHeader] || HEADER_DIRECTIVES.none);

  const claude = createClaudeClient(claudeKey, claudeModel, { useCli: claudeUseCli });
  const site = wpClient.normalizeSite(creds.wpUrl);

  // -------- PASS 1: design system (only if images uploaded) --------
  let designSystem = null;
  if (images.length > 0 && !spliceIntent) {
    emit('analyzing');
    // Cache shared across concurrent runs: variations of the same reference
    // reuse ONE analysis instead of paying for three identical ones.
    const rawDs = await dsCacheGetOrCreate(dsCacheKey(images), () => claude.extractDesignSystem(images));
    try {
      designSystem = JSON.parse(JSON.stringify(JSON.parse(stripFences(rawDs)))); // deep copy per run
    } catch (_) {
      // Non-fatal: proceed without a formal design system.
      designSystem = null;
    }
  }

  // -------- Edit mode: fetch current page --------
  let currentPage = null;
  let legacyContent = null; // non-Elementor page being MIGRATED
  const historyNotes = []; // history failures never break the pipeline
  if (mode === 'edit' && pageId) {
    const existing = await wpClient.getPage(creds, pageId);
    if (Array.isArray(existing.elementor_data) && existing.elementor_data.length) {
      currentPage = {
        title: existing.title,
        page_settings: existing.page_settings || { hide_title: 'yes' },
        content: existing.elementor_data,
        custom_css: existing.custom_css || '',
      };
      // Snapshot the page as it is on the site BEFORE we touch it, so a
      // bad edit can always be rolled back via /api/history/restore.
      try {
        await historyStore.appendVersion(creds, pageId, {
          source: 'backup',
          title: currentPage.title,
          summary: 'Automatic backup before edit',
          pageJson: currentPage,
        });
      } catch (err) {
        historyNotes.push(`History backup failed (non-fatal): ${err.message}`);
      }
    } else if (existing.post_content && String(existing.post_content).trim()) {
      // MIGRATION: the page was built with another builder/editor. Feed the
      // legacy markup to the model to rebuild as native Elementor. The
      // original post_content is never overwritten (the plugin only writes
      // Elementor meta + title/status), so the source stays recoverable.
      legacyContent = {
        builder: existing.builder || 'another builder',
        content: String(existing.post_content),
      };
      historyNotes.push(`Migrated from ${legacyContent.builder} (original post content preserved).`);
    }
    // Pages with neither Elementor data nor content fall back to fresh generation.
  }

  // -------- SECTION-REFINE SPLICE --------
  // A refine scoped to ONE element: regenerate only that element, then splice
  // it back into the freshly fetched page — every OTHER element passes through
  // byte-identical, so the user's manual Elementor edits survive the refine.
  if (spliceIntent && currentPage && Array.isArray(currentPage.content)) {
    const target = currentPage.content.find((el) => el && el.id === sectionId);
    if (target) {
      return runSectionSplice({
        claude, creds, site, currentPage, target, sectionId,
        prompt, allowPro, brandContext, title, status, template, pageId,
        sideloadImages, unsplashKey, imageMode, geminiKey,
        historyNotes, emit,
      });
    }
    historyNotes.push(`Section refine: element "${sectionId}" not found — applied a whole-page refine instead.`);
  }

  // -------- PASS 2: generate the page --------
  emit('generating');
  const rawPage = await claude.generatePage({
    prompt: effectivePrompt,
    designSystem,
    currentPage,
    editInstruction: mode === 'edit' && currentPage ? prompt : null,
    allowPro,
    brandContext,
    // Elementor globals act as the brand kit when the user did not pick an
    // explicit preset; an explicit brandKit always wins.
    brandKit: brandKit || globalKit,
    // Feed the reference/mockup image(s) into generation so the model
    // reproduces the ACTUAL layout, not just the extracted design system.
    images,
    legacyContent,
  });

  // -------- Validate + repair --------
  emit('validating');
  // Fresh generations are guaranteed to use flex containers. Edits/refines
  // ALSO containerize when the page being edited is already container-based
  // (i.e. one of ours) — so a model regression to sections during refine gets
  // converted too. Migrations are fresh builds, so they containerize as well.
  // Only edits of legacy Elementor section/column pages are left alone.
  const currentIsContainers = !!(currentPage && Array.isArray(currentPage.content) &&
    currentPage.content.some((el) => el && el.elType === 'container'));
  const containerize = mode !== 'edit' || currentIsContainers || !!legacyContent;
  let page = await validateAndRepair(rawPage, claude, { allowPro, containerize });
  page._repairs = page._repairs || [];

  // -------- DESIGN LINT: deterministic self-check vs the reference --------
  // "It has to test itself": code-level verification that the build honored
  // the analyzed reference — missing sections, skipped shape dividers, and
  // hand-built patterns where a dedicated widget was mandatory.
  let lintNotes = [];
  try {
    lintNotes = designLint(page, designSystem, allowPro, includeHeader);
    if (lintNotes.length) page._repairs.push(...lintNotes.map((n) => `Design check: ${n}`));
  } catch (_) { /* lint is advisory — never blocks */ }

  // -------- DETERMINISTIC TESTIMONIAL ENFORCEMENT (task; runs in parallel) --
  // Prompt mandates alone proved unreliable here: if the testimonial band was
  // hand-built (no testimonial widget), the pipeline ITSELF rebuilds that ONE
  // section with the native testimonial widget via a focused call and splices
  // it back — every other section untouched. Not optional, not model's choice.
  const runTestimonialEnforcement = async () => {
    if (mode === 'edit' || !lintNotes.some((n) => /testimonial/.test(n))) return;
    const band = findTestimonialBand(page.content);
    if (!band) return;
    try {
      const widgetInstruction =
        'Rebuild this section so each quote is a native `testimonial` widget ' +
        '(testimonial_content, testimonial_name, testimonial_job, ' +
        'testimonial_image:{url:<real unsplash portrait>,id:""}) with a ' +
        '`star-rating` widget above it, one per card container — reuse the ' +
        'exact quotes/names/avatars already present in this section. Keep the ' +
        'section heading/eyebrow/subtext/CTA and the band styling; the card ' +
        'containers stay only as frames around the widgets.';
      const rawBand = await claude.refineElement({
        elementJson: band,
        instruction: widgetInstruction,
        allowPro,
        brandContext,
      });
      let parsedBand = lenientParseJson(rawBand);
      if (parsedBand && Array.isArray(parsedBand.content)) parsedBand = parsedBand.content[0];
      if (parsedBand && parsedBand.elType) {
        const tempPage = await validateAndRepair(JSON.stringify({
          title: page.title, page_settings: page.page_settings,
          content: [parsedBand], custom_css: page.custom_css || '',
        }), claude, { allowPro, containerize: false, cleanupAnchors: false });
        const rebuilt = tempPage.content[0];
        if (rebuilt) {
          rebuilt.id = band.id;
          replaceElementById(page.content, band.id, rebuilt);
          page._repairs.push('Testimonial section refined to use the native testimonial widget.');
        }
      }
    } catch (err) {
      page._repairs.push(`Testimonial widget enforcement skipped (error: ${err.message}).`);
    }
  };

  // -------- HEADER=NONE: no anchors have any purpose — strip them all ------
  if (includeHeader === 'none') {
    let removed = 0;
    (function strip(els) {
      for (const el of els || []) {
        if (!el || !Array.isArray(el.elements)) continue;
        const before = el.elements.length;
        el.elements = el.elements.filter((c) => !(c && c.widgetType === 'menu-anchor'));
        removed += before - el.elements.length;
        strip(el.elements);
      }
    })(page.content);
    if (removed) page._repairs.push(`Removed ${removed} menu-anchor widget(s) — no header/nav exists to link to them.`);
  }

  // -------- AUTO SELF-CORRECTION: fix lint violations in the SAME run --------
  // "It must be professional in the 1st try": when the design check finds real
  // violations (missing widgets/sections/shape dividers), run ONE corrective
  // pass automatically — even without the Auto-refine toggle — so the first
  // generation repairs itself before publishing.
  // The full-page critique is the SLOWEST pass (it re-emits the entire page
  // JSON) — reserve it for STRUCTURAL violations (missing/invented sections,
  // header tiers) or a pile-up of widget notes; single widget-polish notes
  // are already handled by the deterministic enforcement passes.
  // The correction pass runs on EVERY reference-based generation — not gated
  // on the Auto-refine checkbox and not gated on coded lint rules. Coded rules
  // only catch patterns we anticipated; the model comparing the built page
  // against the reference IMAGES catches the rest (static map screenshots,
  // tabs where the reference shows cards, styling drift). Auto-refine remains
  // an EXTRA pass on top of this baseline.
  const critiqueImages = sampleImagesForCritique(images);
  if (!autoRefine && mode !== 'edit' && (lintNotes.length > 0 || critiqueImages.length > 0)) {
    emit('refining');
    try {
      const findings = lintNotes.length
        ? `\n\nAUTOMATED DESIGN-CHECK FINDINGS — your revision MUST fix ALL of these ` +
          `(use the required native widgets; REMOVE any invented sections the reference lacks; ` +
          `never drop sections the reference shows):\n- ${lintNotes.join('\n- ')}`
        : '';
      const rawFix = await claude.critiquePage({
        pageJson: page,
        prompt: `${prompt}${findings}`,
        allowPro,
        brandContext,
        images: critiqueImages,
      });
      const fixed = await validateAndRepair(rawFix, claude, { allowPro, containerize });
      fixed._repairs = fixed._repairs || [];
      const postNotes = designLint(fixed, designSystem, allowPro, includeHeader);
      // Keep the fix unless it TRUNCATED the page (a cut-off rewrite has fewer
      // sections — that used to let a 3-section stump ship) or it INTRODUCED
      // new design-check violations. Equal note counts keep the fix: the whole
      // point of the visual pass is improvements lint can't measure.
      const keptSections = Array.isArray(fixed.content) ? fixed.content.length : 0;
      if (keptSections + 2 < page.content.length) {
        page._repairs.push('Self-correction pass dropped sections (truncated) — kept the original.');
      } else if (postNotes.length <= lintNotes.length) {
        if (postNotes.length < lintNotes.length) {
          fixed._repairs.push(`Self-correction pass fixed ${lintNotes.length - postNotes.length} design-check finding(s).`);
        } else {
          fixed._repairs.push('Self-correction pass reviewed the page against the reference design.');
        }
        if (postNotes.length) fixed._repairs.push(...postNotes.map((n) => `Design check: ${n}`));
        page = fixed;
        lintNotes = postNotes;
      } else {
        page._repairs.push('Self-correction pass introduced new design-check findings — kept the original.');
      }
    } catch (_) {
      page._repairs.push('Self-correction pass skipped (error).');
    }
  }

  // -------- Optional: self-critique refine pass --------
  if (autoRefine) {
    emit('autorefine');
    try {
      const critiquePrompt = lintNotes.length
        ? `${prompt}\n\nAUTOMATED DESIGN-CHECK FINDINGS (fix ALL of these in your revision):\n- ${lintNotes.join('\n- ')}`
        : prompt;
      const rawR = await claude.critiquePage({
        pageJson: page,
        prompt: critiquePrompt,
        allowPro,
        brandContext,
        images: sampleImagesForCritique(images),
      });
      const refined = await validateAndRepair(rawR, claude, { allowPro, containerize });
      if (Array.isArray(refined.content) && refined.content.length + 2 < page.content.length) {
        throw new Error('refine output lost sections (truncated)');
      }
      refined._repairs = refined._repairs || [];
      refined._repairs.push('Auto-refine pass applied.');
      // Re-lint the refined page so the report reflects the final state.
      try {
        const post = designLint(refined, designSystem, allowPro, includeHeader);
        if (post.length) refined._repairs.push(...post.map((n) => `Design check: ${n}`));
      } catch (_) { /* advisory */ }
      page = refined;
    } catch (_) {
      // Refine is best-effort: keep the previous page on any failure.
      page._repairs.push('Auto-refine pass skipped (error).');
    }
  }

  // -------- HEADER MARKER FALLBACK (Free plans / untagged headers) ---------
  // Without Pro there is no nav-menu widget, and unless the model volunteered
  // html_tag:"header" the header carries NO deterministic marker — the
  // one-row mobile enforcement inside the validator silently missed it. Tag
  // the band and re-run the enforcement so every plan gets the guarantee.
  if (mode !== 'edit' && includeHeader !== 'none' && !findHeaderBand(page.content)) {
    const guessed = guessHeaderBand(page.content);
    if (guessed) {
      if (!guessed.settings || typeof guessed.settings !== 'object') guessed.settings = {};
      guessed.settings.html_tag = 'header';
      try { enforceHeaderRows(page.content); } catch (_) { /* advisory */ }
      page._repairs.push('Header band tagged and kept one row on mobile.');
    }
  }

  // -------- DETERMINISTIC HEADER POLISH (task; runs in parallel) -----------
  // The generator repeatedly produces a generic bar instead of the reference
  // header (bar background/shape/overlap, styled menu, matching CTA). Like the
  // testimonial enforcement: the pipeline itself re-styles ONLY the header
  // band in a focused call WITH the reference image attached, then splices it
  // back.
  const runHeaderPolish = async () => {
    if (mode === 'edit' || includeHeader !== 'full' || images.length === 0) return;
    const headerBand = findHeaderBand(page.content);
    if (headerBand) {
      try {
        const headerSpec = designSystem && designSystem.header && typeof designSystem.header === 'object'
          ? '\nANALYZED HEADER SPEC (from the reference — build EXACTLY this):\n' +
            JSON.stringify(designSystem.header) + '\n'
          : '';
        const headerInstruction =
          'Rebuild/restyle this header to look EXACTLY like the header in the ' +
          'attached reference image. Keep the nav-menu widget and the element id.' +
          headerSpec +
          'Match precisely: (1) the TIER STRUCTURE — one row per horizontal strip ' +
          'in the reference (a thin topbar with phone/email/socials/links is its ' +
          'OWN row ABOVE the main bar; never merge tiers into one row); (2) each ' +
          'tier\'s EXACT background color sampled from the image — tiers often ' +
          'differ (e.g. a red utility strip over a BLACK main bar); dark/' +
          'translucent glassy bars use rgba background_color; never leave a plain ' +
          'white bar unless the image shows one; (3) the bar SHAPE — rounded pill ' +
          '(border_radius) + horizontal margins if shown; if the bar floats OVER ' +
          'the hero, negative bottom margin + z_index; (4) the nav-menu STYLE ' +
          'keys — menu_typography_*, color_menu_item, color_menu_item_hover, ' +
          'pointer ("background" for pill-highlight active items, "underline" ' +
          'only if the image shows underlines), color_menu_item_active; (5) the ' +
          'CTA — copy its VERBATIM label, fill color, text color and shape from ' +
          'the image (a phone-pill CTA ONLY if the main bar shows a phone number ' +
          'as the button; a phone in the topbar is a small icon-list/text item in ' +
          'that tier, with link.url "tel:+<number>"); (6) the logo styling ' +
          '(colors/size/panel shape as shown). ' +
          'MOBILE: each tier stays ONE line (flex_wrap_mobile:"nowrap", widgets ' +
          '_element_width:"auto") and the CTA stays VISIBLE — never hide_mobile.';
        const rawHdr = await claude.refineElement({
          elementJson: headerBand,
          instruction: headerInstruction,
          allowPro,
          brandContext,
          // The header lives at the TOP of the reference — sending all 24
          // scan segments tripled this call's size for nothing.
          images: images.slice(0, 2),
        });
        let parsedHdr = lenientParseJson(rawHdr);
        if (parsedHdr && Array.isArray(parsedHdr.content)) parsedHdr = parsedHdr.content[0];
        if (Array.isArray(parsedHdr)) parsedHdr = parsedHdr[0];
        if (!parsedHdr || !parsedHdr.elType) {
          page._repairs.push('Header polish returned an unusable result — original header kept.');
        } else {
          const tempPage = await validateAndRepair(JSON.stringify({
            title: page.title, page_settings: page.page_settings,
            content: [parsedHdr], custom_css: page.custom_css || '',
          }), claude, { allowPro, containerize: false, cleanupAnchors: false });
          const rebuiltHdr = tempPage.content[0];
          // A polish that LOST the nav menu would be a downgrade — but only
          // demand nav-menu when the original band had one (Free-plan headers
          // legitimately have none; validation strips nav-menu without Pro).
          const mustKeepNav = allowPro && JSON.stringify(headerBand).includes('"nav-menu"');
          if (!rebuiltHdr) {
            page._repairs.push('Header polish produced an empty result — original header kept.');
          } else if (mustKeepNav && !JSON.stringify(rebuiltHdr).includes('"nav-menu"')) {
            page._repairs.push('Header polish dropped the nav menu — original header kept.');
          } else {
            rebuiltHdr.id = headerBand.id;
            replaceElementById(page.content, headerBand.id, rebuiltHdr);
            dedupeIds(page.content);
            page._repairs.push('Header styled to match the reference design.');
          }
        }
      } catch (err) {
        page._repairs.push(`Header polish skipped (error: ${err.message}).`);
      }
    }
  };

  // -------- LOOP GRID UPGRADE (task; runs in parallel) ---------------------
  // When the page has a posts widget and reference images exist: design ONE
  // custom card (a deterministic dynamic-tag skeleton restyled by the model
  // against the reference), save it as a loop-item template in the site's
  // Elementor library (plugin v1.4.0+), and swap the posts widget for the
  // native loop-grid pointing at it. ANY failure keeps the proven posts
  // widget — a page always publishes.
  const runLoopUpgrade = async () => {
    if (mode === 'edit' || !allowPro || images.length === 0) return;
    let postsWidget = null;
    (function findPosts(els) {
      for (const el of els || []) {
        if (postsWidget) return;
        if (el && el.elType === 'widget' && el.widgetType === 'posts') { postsWidget = el; return; }
        if (el && Array.isArray(el.elements)) findPosts(el.elements);
      }
    })(page.content);
    if (postsWidget) {
      try {
        const skeleton = buildLoopCardSkeleton(designSystem);
        const cardInstruction =
          'This is ONE blog-post CARD (a loop-item template). Restyle it to look ' +
          'EXACTLY like a single post card in the attached reference image — card ' +
          'surface/border/radius/shadow, category chip style, title/excerpt/date ' +
          'typography and colors, the read-more button style with its VERBATIM ' +
          'label, spacing. You may reorder the existing widgets, wrap them in ' +
          'styled inner containers, overlay the date/category on the image ' +
          '(_position:"absolute" on that widget inside the image area), or remove ' +
          'a widget the reference card lacks. HARD RULES: (1) NEVER remove or ' +
          'alter any `__dynamic__` setting — every kept widget keeps its exact ' +
          '__dynamic__ binding; (2) do not add new dynamic tags; (3) the result ' +
          'stays ONE top-level container; (4) keep static placeholder values ' +
          'alongside the bindings.';
        const rawCard = await claude.refineElement({
          elementJson: skeleton,
          instruction: cardInstruction,
          allowPro,
          brandContext,
          // A small representative sample carries the card design.
          images: images.length > 3
            ? [images[0], images[Math.floor(images.length / 2)], images[images.length - 1]]
            : images,
        });
        let card = lenientParseJson(rawCard);
        if (card && Array.isArray(card.content)) card = card.content[0];
        if (Array.isArray(card)) card = card[0];
        if (card && card.elType) {
          const tempPage = await validateAndRepair(JSON.stringify({
            title: page.title, page_settings: page.page_settings,
            content: [card], custom_css: '',
          }), claude, { allowPro, containerize: false, cleanupAnchors: false });
          let finalCard = tempPage.content[0];
          if (!finalCard || !loopCardBindingsIntact(finalCard)) {
            // Styling pass broke the wiring — the skeleton is already palette
            // -styled and always correct.
            finalCard = buildLoopCardSkeleton(designSystem);
            page._repairs.push('Custom card styling was rejected (dynamic bindings lost) — used the standard card.');
          }
          const created = await wpClient.createTemplate(creds, {
            title: `${page.title} — Blog Card`,
            type: 'loop-item',
            content: [finalCard],
          });
          if (created && created.id) {
            const oldSettings = postsWidget.settings || {};
            const grid = buildLoopGridWidget(created.id, {
              columns: oldSettings.classic_columns || oldSettings.cards_columns || '3',
              postsPerPage: oldSettings.classic_posts_per_page || oldSettings.cards_posts_per_page || 3,
            });
            // Reference shows filter pills above the posts? Wire LIVE category
            // filtering: taxonomy-filter widget bound to the grid's element id.
            let replacement = grid;
            let filterWidget = null;
            if (referenceShowsBlogFilter(designSystem)) {
              // Kill any hand-built decorative pill row in the blog band first.
              const blogBand = page.content.find((b) => b && JSON.stringify(b).includes(postsWidget.id));
              if (blogBand) removeFakeFilterPills(blogBand, page._repairs);
              filterWidget = buildTaxonomyFilterWidget(grid.id, designSystem);
              replacement = {
                id: hexId(), elType: 'container', isInner: true,
                settings: {
                  content_width: 'full', flex_direction: 'column',
                  flex_align_items: 'center',
                  flex_gap: { column: '0', row: '32', isLinked: false, unit: 'px' },
                },
                elements: [filterWidget, grid],
              };
            }
            replaceElementById(page.content, postsWidget.id, replacement);
            dedupeIds(page.content);
            // dedupe may have re-minted the grid id — re-bind the filter.
            if (filterWidget) filterWidget.settings.selected_element = grid.id;
            page._repairs.push(
              'Blog section upgraded to a custom loop card matching the reference (template #' + created.id + ')' +
              (filterWidget ? ' with live category filter tabs.' : '.')
            );
          }
        }
      } catch (err) {
        // Plugin too old (no /templates route) or any other failure: the
        // posts widget stays — still a fully working blog section.
        page._repairs.push(`Custom blog card skipped (${err.message}) — the standard posts widget is used.`);
      }
    }
  };

  // -------- PARALLEL POLISH: the three focused passes touch DIFFERENT
  // elements (testimonial band, header band, blog band) — run their slow
  // model calls CONCURRENTLY instead of queueing them (3x faster tail).
  if (mode !== 'edit' && !variationMode) {
    const pageStr = JSON.stringify(page.content);
    const hasWork =
      (lintNotes.some((n) => /testimonial/.test(n)) && !!findTestimonialBand(page.content)) ||
      (includeHeader === 'full' && images.length > 0 && !!findHeaderBand(page.content)) ||
      (allowPro && images.length > 0 && pageStr.includes('"widgetType":"posts"'));
    if (hasWork) {
      emit('refining');
      await Promise.allSettled([
        runTestimonialEnforcement(),
        runHeaderPolish(),
        runLoopUpgrade(),
      ]);
    }
  }

  // -------- HEADER SPEC ENFORCEMENT (deterministic — no AI judgment) -------
  // Tier backgrounds and the CTA label come straight from the analyzed
  // reference spec. The model swapping tier colors or paraphrasing the CTA
  // ("GET A FREE QUOTE" instead of "GET YOUR FREE ESTIMATE") is corrected in
  // code, every time.
  if (mode !== 'edit' && includeHeader !== 'none' && designSystem &&
      designSystem.header && typeof designSystem.header === 'object') {
    try { enforceHeaderSpec(page, designSystem.header); } catch (_) { /* advisory */ }
  }

  // Price tables the model left default-grey get the page palette (code-level).
  // Prompt-only builds (AI chat) have no analyzed design system — derive a
  // palette from the built page itself so the stylers still fire.
  if (mode !== 'edit') {
    const styleDS = designSystem || derivePaletteFromPage(page);
    if (styleDS) {
      try { stylePriceTables(page, styleDS); } catch (_) { /* advisory */ }
      try { styleServiceAreas(page, styleDS); } catch (_) { /* advisory */ }
    }
  }

  // -------- FINAL INVARIANTS (last line of defense before publish) ---------
  // Passes that splice content AFTER the main validation can reintroduce
  // violations (a polish result carrying a second header, an invented band
  // the critique failed to remove). Re-enforce the hard rules on the FINAL
  // page state in code.
  if (mode !== 'edit') {
    try {
      // "No header" is a COMMAND: delete any header the model built anyway
      // (nav-menu band or html_tag:"header" band near the top, plus its
      // topbar strip).
      if (includeHeader === 'none') {
        const els = page.content;
        for (let i = Math.min(3, els.length - 1); i >= 0; i--) {
          const el = els[i];
          if (!el || typeof el !== 'object') continue;
          const isHeader = (el.settings && el.settings.html_tag === 'header') ||
            JSON.stringify(el).includes('"nav-menu"');
          if (isHeader) {
            els.splice(i, 1);
            // The strip above it (dispatch text / ratings, no H1, few widgets)
            // was part of the same header — remove it too.
            const prev = els[i - 1];
            if (prev && !subtreeHasH1(prev) && !JSON.stringify(prev).includes('"widgetType":"button"')) {
              let wc = 0;
              (function cnt(n) { if (!n || typeof n !== 'object') return; if (n.elType === 'widget') wc++; (n.elements || []).forEach(cnt); })(prev);
              if (wc > 0 && wc <= 6) els.splice(i - 1, 1);
            }
            page._repairs.push('Removed a header the model built despite "No header" being selected.');
            break;
          }
        }
      }
      dedupeTopbarStrips(page.content, page._repairs);
      dedupeHeaderBands(page.content, page._repairs);
      const finalNotes = designLint(page, designSystem, allowPro, includeHeader);
      if (finalNotes.some((n) => /invented blog/.test(n))) {
        removeBandsWithWidget(page, ['posts', 'loop-grid'], 'blog');
      }
      if (finalNotes.some((n) => /invented gallery/.test(n))) {
        removeBandsWithWidget(page, ['image-carousel', 'gallery', 'image-gallery', 'media-carousel'], 'gallery');
      }
      if (finalNotes.some((n) => /invented pricing/.test(n))) {
        removeBandsWithWidget(page, ['price-table'], 'pricing');
      }
    } catch (_) { /* invariants are best-effort — never block publish */ }
  }

  const repairs = page._repairs || [];
  delete page._repairs; // never send internal notes to the plugin
  if (historyNotes.length) repairs.push(...historyNotes);

  // -------- Images: generate (Gemini) or resolve (Unsplash), then sideload --------
  const useGemini = imageMode === 'gemini' && !!geminiKey;
  if (imageMode === 'gemini' && !geminiKey) {
    repairs.push('AI-generated images were selected but NO Gemini API key reached the backend — stock images were used. Add and Test the key on the Connect screen.');
  }
  const externalBefore = hasExternalImageRefs(page.content);
  if (useGemini || unsplashKey || externalBefore) {
    emit('images');
    if (useGemini) {
      const n = await resolveGeminiImages(page.content, geminiKey, creds, wpClient, prompt);
      if (n > 0) repairs.push(`Generated ${n} image${n === 1 ? '' : 's'} with Gemini.`);
      const needed = resolveGeminiImages.lastNeeded || 0;
      const stripped = resolveGeminiImages.lastStripped || 0;
      if (needed > 0 && n === 0) {
        repairs.push('Gemini image generation FAILED for every image even after retries (check the API key with the Test button on Connect) — those image slots were left EMPTY (Gemini-only mode: no stock URLs). Fix the key and regenerate.');
      } else if (stripped > 0) {
        repairs.push(`Gemini could not generate ${stripped} of ${needed} images after 4 attempts each (API errors or quota) — those slots were left EMPTY (Gemini-only mode: no stock URLs). Use Refine to fill them or regenerate.`);
      }
    } else if (unsplashKey) {
      await resolveUnsplashImages(page.content, unsplashKey, prompt);
    }
    // Sideload any remaining external URLs (Gemini-uploaded images already
    // carry a real attachment id, so they are skipped here).
    if (sideloadImages) {
      await sideloadAndSwap(page.content, creds, wpClient, repairs);
    }
  } else if (sideloadImages) {
    // No external/Unsplash images to resolve; sideload is a no-op but kept
    // for behavioral parity (harmless when nothing matches).
    await sideloadAndSwap(page.content, creds, wpClient, repairs);
  }

  // ALWAYS health-check whatever is still external after the image stage —
  // hallucinated (404) photo ids must never ship a broken image frame,
  // regardless of sideload/Gemini settings.
  try {
    await verifyExternalImages(page.content, repairs, site.replace(/^https?:\/\//, ''));
  } catch (_) { /* best-effort */ }

  // -------- Publish --------
  emit('publishing');
  const payload = {
    title: title || page.title,
    status,
    template,
    elementor_data: page.content,
    page_settings: page.page_settings,
    custom_css: page.custom_css,
  };
  if (mode === 'edit' && pageId) payload.page_id = pageId;

  const saved = await wpClient.savePage(creds, payload);

  // -------- History: record the version we just published --------
  // Best-effort — a history failure must never break a successful publish.
  try {
    await historyStore.appendVersion(creds, saved.id, {
      source: mode === 'edit' ? 'refine' : 'generate',
      title: payload.title,
      summary: String(prompt || '').slice(0, 80),
      pageJson: {
        title: payload.title,
        page_settings: page.page_settings,
        content: page.content,
        custom_css: page.custom_css,
      },
    });
  } catch (err) {
    repairs.push(`History save failed (non-fatal): ${err.message}`);
  }

  // -------- Pro-widget report on the FINAL page content --------
  let proWidgets = { used: [], allowPro: !!allowPro };
  try {
    proWidgets = buildProReport(page.content, allowPro);
  } catch (_) {
    // Report is informational only — never block a successful publish.
  }

  // Cross-run usage tracking (zero-usage runs count too — they are the
  // denominator for "is Pro worth it" percentages). Best-effort.
  try {
    await proUsageStore.recordUsage(creds, saved.id, proWidgets.used || []);
  } catch (_) { /* tracking must never block a publish */ }

  const out = {
    pageId: saved.id,
    pageUrl: saved.link,
    editorUrl: saved.editor_link || EDITOR_LINK(site, saved.id),
    status: saved.status,
    rawJson: page,        // for the "download raw JSON" UI action
    repairs,              // for logging / debugging
    proWidgets,           // Pro widgets used + suggested free alternatives
  };
  emit('done', out);
  return out;
}

/**
 * ------------------------------------------------------------
 * SECTION-REFINE SPLICE branch.
 *
 * Regenerates ONE element of a live page from a focused instruction, then
 * splices it back into the freshly fetched page content. Every other
 * element passes through byte-identical — the user's manual Elementor edits
 * are preserved. Skips the design-system pass; still runs the images stage
 * (scoped to the updated element only) and publishes + records history +
 * the Pro report on the FULL spliced content.
 * ------------------------------------------------------------
 */
async function runSectionSplice({
  claude, creds, site, currentPage, target, sectionId,
  prompt, allowPro, brandContext, title, status, template, pageId,
  sideloadImages, unsplashKey, imageMode, geminiKey,
  historyNotes, emit,
}) {
  // -------- Generate the updated element --------
  emit('generating');
  const rawEl = await claude.refineElement({
    elementJson: target,
    instruction: prompt,
    allowPro,
    brandContext,
  });

  // -------- Validate + normalize the single element --------
  emit('validating');
  let parsedEl = lenientParseJson(rawEl);
  if (!parsedEl) {
    // One slow model round-trip as a fallback, mirroring parseWithRepair.
    try {
      parsedEl = lenientParseJson(await claude.repairJson(rawEl, 'Element JSON did not parse.'));
    } catch (_) { /* handled below */ }
  }
  // Defensive: the model sometimes wraps the element in a full page object.
  if (parsedEl && !parsedEl.elType && Array.isArray(parsedEl.content) && parsedEl.content.length) {
    parsedEl = parsedEl.content[0];
  }
  if (!parsedEl || typeof parsedEl !== 'object' || typeof parsedEl.elType !== 'string') {
    const e = new Error('Section refine: could not obtain a valid updated element from the model.');
    e.rawOutput = rawEl;
    throw e;
  }

  // Normalize/whitelist via the standard page validator on a temp one-element
  // page. containerize:false (respect whatever layout model the page uses);
  // cleanupAnchors:false (anchor links living in OTHER sections are not
  // visible here, so anchors in this element must not be pruned).
  const tempPage = {
    title: currentPage.title,
    page_settings: currentPage.page_settings,
    content: [parsedEl],
    custom_css: currentPage.custom_css,
  };
  const validated = await validateAndRepair(JSON.stringify(tempPage), claude, {
    allowPro,
    containerize: false,
    cleanupAnchors: false,
  });
  const repairs = validated._repairs || [];
  const updatedEl = validated.content[0];
  updatedEl.id = sectionId; // the splice below matches on this exact id

  // -------- Splice: only the target element changes --------
  const newContent = currentPage.content.map((el) => (el && el.id === sectionId ? updatedEl : el));
  repairs.push(`Section refine: replaced element "${sectionId}"; all other elements untouched.`);

  // -------- Images: scoped to the UPDATED element only --------
  const scoped = [updatedEl];
  const useGemini = imageMode === 'gemini' && !!geminiKey;
  const externalBefore = hasExternalImageRefs(scoped);
  if (useGemini || unsplashKey || externalBefore) {
    emit('images');
    if (useGemini) {
      const n = await resolveGeminiImages(scoped, geminiKey, creds, wpClient, prompt);
      if (n > 0) repairs.push(`Generated ${n} image${n === 1 ? '' : 's'} with Gemini.`);
    } else if (unsplashKey) {
      await resolveUnsplashImages(scoped, unsplashKey, prompt);
    }
    if (sideloadImages) {
      await sideloadAndSwap(scoped, creds, wpClient);
    }
  } else if (sideloadImages) {
    await sideloadAndSwap(scoped, creds, wpClient);
  }

  // -------- Publish the FULL spliced content --------
  emit('publishing');
  const payload = {
    title: title || currentPage.title,
    status,
    template,
    elementor_data: newContent,
    page_settings: currentPage.page_settings,
    custom_css: currentPage.custom_css,
    page_id: pageId,
  };
  const saved = await wpClient.savePage(creds, payload);

  // -------- History (best-effort) --------
  try {
    await historyStore.appendVersion(creds, saved.id, {
      source: 'refine',
      title: payload.title,
      summary: 'Section refine: ' + String(prompt || '').slice(0, 60),
      pageJson: {
        title: payload.title,
        page_settings: payload.page_settings,
        content: newContent,
        custom_css: payload.custom_css,
      },
    });
  } catch (err) {
    repairs.push(`History save failed (non-fatal): ${err.message}`);
  }

  // -------- Pro-widget report + usage on the FULL spliced content --------
  let proWidgets = { used: [], allowPro: !!allowPro };
  try {
    proWidgets = buildProReport(newContent, allowPro);
  } catch (_) { /* informational only */ }
  try {
    await proUsageStore.recordUsage(creds, saved.id, proWidgets.used || []);
  } catch (_) { /* tracking must never block a publish */ }

  if (historyNotes.length) repairs.push(...historyNotes);

  const out = {
    pageId: saved.id,
    pageUrl: saved.link,
    editorUrl: saved.editor_link || EDITOR_LINK(site, saved.id),
    status: saved.status,
    rawJson: {
      title: payload.title,
      page_settings: payload.page_settings,
      content: newContent,
      custom_css: payload.custom_css,
    },
    repairs,
    proWidgets,
  };
  emit('done', out);
  return out;
}

/** Progress detail for the images stage: 'resolving N images'. */
function imagesDetail(content, useGemini) {
  let n = 0;
  if (useGemini) {
    const slots = [];
    collectGeminiSlots(content, slots, null);
    n = Math.min(slots.filter((sl) => sl.needs).length, 8);
  } else {
    const targets = [];
    collectImageRefs(content, targets);
    n = new Set(
      targets.map((t) => t.getUrl()).filter((u) => u && /^https?:\/\//i.test(u))
    ).size;
  }
  return `resolving ${n} image${n === 1 ? '' : 's'}`;
}

/**
 * ------------------------------------------------------------
 * DESIGN LINT — deterministic post-build verification against the
 * analyzed reference. Returns human-readable findings (advisory):
 *   1. Section completeness: reference band count vs built bands.
 *   2. Shape dividers: analysis saw curved/organic transitions but
 *      the page uses zero shape_divider_* settings.
 *   3. Widget-first: the reference implies a pattern with a dedicated
 *      widget (pricing/slider/FAQ/gallery/testimonials/form) but the
 *      page never uses that widget.
 * ------------------------------------------------------------
 */
function designLint(page, designSystem, allowPro, includeHeader) {
  const notes = [];
  if (!designSystem || !page || !Array.isArray(page.content)) return notes;

  const pageStr = JSON.stringify(page.content);
  const widgetTypes = new Set();
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      if (el.widgetType) widgetTypes.add(el.widgetType);
      walk(el.elements);
    }
  })(page.content);

  // 1) Section completeness — BOTH directions. Too few bands = sections were
  //    skipped; too many = the model padded a partial reference (e.g. a
  //    header+hero-only mockup) out to a "complete" page it was never shown.
  const refSections = Array.isArray(designSystem.sections) ? designSystem.sections : [];
  if (refSections.length > 0) {
    const built = page.content.length;
    const names = refSections.map((s) => String(s).split(':')[0].slice(0, 40));
    if (built < refSections.length - 1) {
      notes.push(
        `reference shows ${refSections.length} sections but the page has ${built} top-level bands — ` +
        `verify none were skipped (reference bands: ${names.join(' | ')}).`
      );
    } else if (built > refSections.length + 1) {
      notes.push(
        `the reference shows ONLY ${refSections.length} section(s) (${names.join(' | ')}) but the page has ` +
        `${built} top-level bands — the reference defines the ENTIRE scope, even when it is a partial page. ` +
        `REMOVE every band not visible in the reference images (no padded-out services/about/testimonials/CTA/footer).`
      );
    }
  }

  // 2) Shape dividers the analysis reported but the build ignored.
  const dsStr = JSON.stringify(designSystem).toLowerCase();
  const mentionsShape = /shape divider|wavy|wave |curve|curved|organic transition|slanted|tilt/.test(dsStr);
  if (mentionsShape && !/shape_divider_(top|bottom)/.test(pageStr)) {
    notes.push('the reference analysis mentions curved/wave/organic section transitions but the page uses NO shape_divider_top/bottom settings.');
  }

  // 3) Widget-first: implied pattern -> required widget(s).
  const rules = [
    { re: /pricing|price table|price plan|membership tier/, widgets: allowPro ? ['price-table'] : [], label: 'pricing → price-table' },
    { re: /slider|carousel hero|rotating hero/, widgets: allowPro ? ['slides', 'media-carousel', 'image-carousel'] : ['image-carousel'], label: 'slider → slides/carousel' },
    { re: /\bfaq\b|frequently asked/, widgets: ['accordion', 'toggle'], label: 'FAQ → accordion' },
    { re: /gallery|portfolio grid|photo grid|our work|projects grid/, widgets: allowPro ? ['gallery', 'image-gallery', 'image-carousel'] : ['image-gallery', 'image-carousel'], label: 'gallery → gallery widget' },
    // Testimonials: the testimonial WIDGETS are mandatory (owner's rule:
    // widgets first, always — containers only when no widget exists).
    {
      re: /testimonial|reviews|what.{0,20}(clients|customers|neighbors) say/,
      widgets: ['testimonial'],
      label: 'testimonials → the static testimonial widget ONLY (sliders are banned)',
    },
    { re: /contact form|request (a )?quote|free estimate|lead form|get your free/, widgets: allowPro ? ['form'] : [], label: 'form → form widget' },
    {
      re: /from (our|the) blog|our blog|\bblog\b|latest (news|posts|articles)|recent (posts|articles)|news & insights|tips & advice|read more|\bbyline\b|publish(ed)? date/,
      widgets: allowPro ? ['posts'] : [],
      label: 'blog/news section → dynamic posts widget (hand-built post cards are not allowed)',
    },
    {
      re: /\bmap\b|google maps|service area map|location map|find us on/,
      widgets: ['google_maps'],
      label: 'map → the real google_maps widget (NEVER a static map screenshot image)',
    },
    {
      re: /video (section|band|embed|player)|embedded video|watch (our|the) video|play.?button overlay|(youtube|vimeo) (video|embed|player)/,
      widgets: ['video'],
      altPageMatch: /"background_video_link":"https?:/,
      label: 'video → the real video widget (or a container background video) — NEVER a screenshot of a player',
    },
    {
      re: /\bcountdown\b|timer (digits|display|strip|bar)|days.{0,8}hours.{0,8}(minutes|mins)/,
      widgets: allowPro ? ['countdown'] : [],
      label: 'countdown → the countdown widget (static timer digits are not allowed)',
    },
    {
      re: /social (media )?icons?|social links? (row|bar|strip)|follow us on/,
      widgets: ['social-icons'],
      label: 'social icons → the social-icons widget (not a row of individual icon widgets)',
    },
    {
      re: /star ratings?|rating stars|[★⭐]|stars? (above|below|under|beneath|next to)/,
      widgets: ['star-rating', 'rating'],
      label: 'star ratings → the star-rating widget (never unicode stars typed into a heading)',
    },
    {
      re: /animated (counters?|numbers)|stats? (band|strip|row|bar|counters?)|number counters?|count.?up numbers|milestone numbers/,
      widgets: ['counter'],
      label: 'stats band → counter widgets (animated numbers, not plain headings)',
    },
    {
      re: /animated headline|rotating (words?|text)|typewriter (effect|text)|typing effect/,
      widgets: allowPro ? ['animated-headline'] : [],
      label: 'animated/rotating headline → the animated-headline widget',
    },
  ];
  for (const rule of rules) {
    if (!rule.widgets.length) continue;
    if (!rule.re.test(dsStr)) continue;
    const widgetOk = rule.widgets.some((w) => widgetTypes.has(w));
    const altOk = rule.altPageMatch ? rule.altPageMatch.test(pageStr) : false;
    if (!widgetOk && !altOk) {
      notes.push(`the reference implies "${rule.label}" but the page does not use ${rule.widgets.join('/')} — hand-built lookalikes are not allowed when the widget exists.`);
    }
  }

  // 4) Full header requested (Pro): the nav-menu widget is mandatory.
  if (includeHeader === 'full' && allowPro && !widgetTypes.has('nav-menu')) {
    notes.push('a FULL header was requested but the page has no nav-menu widget — the real nav-menu is mandatory for full headers on Pro sites.');
  }

  // 5) INVENTED sections: widget-first must never ADD patterns the reference
  //    lacks. Reference fidelity is two-way — nothing missing AND nothing
  //    invented. Each check: the page HAS the pattern, the analysis text
  //    NEVER mentions it.
  if (widgetTypes.has('price-table') && !/pricing|price table|price plan|membership tier|\$\d/.test(dsStr)) {
    notes.push('the page contains a price-table but the reference shows NO pricing section — remove the invented pricing section (reference fidelity is two-way).');
  }
  // Scope invented checks to the SECTIONS list ONLY — the full analysis text
  // always contains words like "photos"/"read more" in styling notes, which
  // made these checks permanently blind.
  const sectionsStr = (Array.isArray(designSystem.sections) ? designSystem.sections : [])
    .map((x) => String(x)).join(' | ').toLowerCase();
  if ((widgetTypes.has('posts') || widgetTypes.has('loop-grid')) &&
      !/blog|news|articles?|latest posts|recent posts|post (grid|cards)|insights band/.test(sectionsStr)) {
    notes.push('the page contains a blog/posts section but the reference sections show NO blog — REMOVE the invented blog section entirely (reference fidelity is two-way).');
  }
  if ((widgetTypes.has('image-carousel') || widgetTypes.has('gallery') || widgetTypes.has('image-gallery') || widgetTypes.has('media-carousel')) &&
      !/gallery|portfolio|our work|recent (work|projects|installs)|projects? (grid|carousel|band|section)|showcase|logo (strip|row|carousel)|partners row|clients row|slider|carousel/.test(sectionsStr)) {
    notes.push('the page contains a gallery/carousel section but the reference sections show NO gallery — REMOVE the invented gallery section entirely (reference fidelity is two-way).');
  }

  if (widgetTypes.has('video') &&
      !/video|watch|youtube|vimeo|play.?button|trailer|showreel/.test(sectionsStr)) {
    notes.push('the page embeds a video widget but the reference sections show NO video — REMOVE the invented video section entirely (reference fidelity is two-way).');
  }
  if (widgetTypes.has('countdown') &&
      !/countdown|timer|sale ends|offer ends|expires|limited.?time/.test(sectionsStr)) {
    notes.push('the page contains a countdown timer but the reference sections show NO countdown/urgency timer — REMOVE the invented countdown (reference fidelity is two-way).');
  }
  if ((widgetTypes.has('accordion') || widgetTypes.has('toggle')) &&
      !/faq|frequently asked|questions|accordion|expand|collaps|toggle/.test(sectionsStr)) {
    notes.push('the page contains an accordion/toggle but the reference sections show NO FAQ/expandable content — REMOVE the invented FAQ section entirely (reference fidelity is two-way).');
  }
  if ((widgetTypes.has('progress') || widgetTypes.has('progress-bar')) &&
      !/progress|skill bars?|percent/.test(sectionsStr)) {
    notes.push('the page contains progress/skill bars but the reference sections show NO progress bars — REMOVE the invented section (reference fidelity is two-way).');
  }
  if (widgetTypes.has('flip-box') &&
      !/flip|hover.?reveal|interactive cards?/.test(sectionsStr)) {
    notes.push('the page uses flip-box widgets but the reference shows NO flip/hover-reveal cards — rebuild that band with the ACTUAL card style the reference shows (icon-box/image-box), flip boxes are not a substitute.');
  }

  // 5b) Misused tabs: the tabs widget appears but the reference never shows
  //     a tabbed interface — the model used it as a lazy substitute for the
  //     reference's real layout.
  if ((widgetTypes.has('tabs') || widgetTypes.has('nested-tabs')) &&
      !/tabs?|tabbed/.test(sectionsStr)) {
    notes.push('the page uses a tabs widget but the reference shows NO tabbed interface — rebuild that section with the ACTUAL layout the reference shows (tabs are not a substitute).');
  }

  // 6) Header tier structure: a 2-tier reference header (utility strip +
  //    main bar) flattened into one bar is a mismatch the user sees instantly.
  const hdrSpec = designSystem.header;
  if (includeHeader !== 'none' && hdrSpec && Array.isArray(hdrSpec.tiers) && hdrSpec.tiers.length >= 2) {
    const band = findHeaderBand(page.content);
    let tierRows = 0;
    if (band) {
      tierRows = (Array.isArray(band.elements) ? band.elements : [])
        .filter((e) => e && e.elType === 'container').length;
      if (tierRows === 0) tierRows = 1; // the band itself is one bar row
      // A separate top-level topbar band right before the header also counts.
      const idx = page.content.indexOf(band);
      if (idx > 0) {
        const prev = page.content[idx - 1];
        if (prev && prev.elType === 'container' && !subtreeHasH1(prev)) tierRows += 1;
      }
    }
    if (!band || tierRows < hdrSpec.tiers.length) {
      notes.push(
        `the reference header has ${hdrSpec.tiers.length} tiers (e.g. a utility topbar strip ABOVE the main bar) ` +
        `but the built header has ${tierRows || 0} — build EVERY tier as its own row with its exact background color and contents (see design_system.header).`
      );
    }
  }

  // 7) Recorded background treatments must survive the build: the analysis
  //    marked diagonal wedges / gradients, but the page ships zero gradient
  //    backgrounds -> the design identity was silently flattened.
  const bgSpecStr = (Array.isArray(designSystem.sections) ? designSystem.sections : [])
    .map((x) => String(x)).join(' | ').toLowerCase();
  const wantsAngles = /diagonal|wedge|angled|hard.?stop|half.and.half|split background|gradient/.test(bgSpecStr);
  const hasGradients = /"background_background":"gradient"/.test(pageStr);
  if (wantsAngles && !hasGradients) {
    notes.push('the reference sections record diagonal/gradient band backgrounds but the page uses ZERO gradient backgrounds — rebuild those bands with their recorded hard-stop gradient wedges/colors (see design_system.sections bg specs).');
  }

  return notes;
}

/**
 * Find the top-level testimonial band (by testimonial-ish heading text).
 * Returns the element or null.
 */
function findTestimonialBand(content) {
  const re = /testimonial|reviews|clients? say|customers? say|neighbors say|trusts?\s/i;
  for (const el of content || []) {
    if (!el || typeof el !== 'object') continue;
    let found = false;
    (function walk(node) {
      if (found || !node || typeof node !== 'object') return;
      if (node.widgetType === 'heading' && node.settings && re.test(String(node.settings.title || ''))) {
        found = true;
        return;
      }
      (node.elements || []).forEach(walk);
    })(el);
    if (found) return el;
  }
  return null;
}

/** True when the subtree contains the given widget type. */
function subtreeHasWidget(el, widgetType) {
  let found = false;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (node.widgetType === widgetType) { found = true; return; }
    (node.elements || []).forEach(walk);
  })(el);
  return found;
}

/** True when the subtree contains an H1 heading (hero fingerprint). */
function subtreeHasH1(el) {
  let found = false;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (node.widgetType === 'heading' && node.settings &&
        String(node.settings.header_size || '') === 'h1') { found = true; return; }
    (node.elements || []).forEach(walk);
  })(el);
  return found;
}

/**
 * Locate the header band: the first top-level element tagged html_tag:"header"
 * or containing a nav-menu widget. When that element ALSO wraps the hero
 * (contains an H1), descend into the child that carries the header marker so
 * the polish targets the bar, not the whole hero. Returns element or null.
 */
function findHeaderBand(content) {
  const hasMarker = (el) => !!el && typeof el === 'object' && (
    (el.settings && typeof el.settings === 'object' && el.settings.html_tag === 'header') ||
    subtreeHasWidget(el, 'nav-menu'));
  for (const el of content || []) {
    if (!hasMarker(el)) continue;
    let band = el;
    for (let i = 0; i < 6 && subtreeHasH1(band); i++) {
      const next = (Array.isArray(band.elements) ? band.elements : []).find(hasMarker);
      if (!next) break;
      band = next;
    }
    return band;
  }
  return null;
}

/**
 * Free-plan fallback: without Pro there is no nav-menu widget, and unless the
 * model volunteered html_tag:"header" the header has NO deterministic marker —
 * the one-row enforcement would silently miss it. Conservative fingerprint:
 * the FIRST top-level band, only when it looks like a bar (a handful of
 * widgets, a logo-style heading/image or a button, and NO H1 — heroes always
 * carry the H1). Returns the element or null.
 */
function guessHeaderBand(content) {
  const first = (Array.isArray(content) ? content : [])[0];
  if (!first || first.elType !== 'container') return null;
  if (first.settings && first.settings.html_tag === 'header') return first;
  let widgets = 0; let hasH1 = false; let barLike = false;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.elType === 'widget') {
      widgets++;
      const s = node.settings || {};
      if (node.widgetType === 'heading' && String(s.header_size || '') === 'h1') hasH1 = true;
      if (node.widgetType === 'button' || node.widgetType === 'image' ||
          node.widgetType === 'icon-list' ||
          (node.widgetType === 'heading' && ['div', 'span'].includes(String(s.header_size || '')))) {
        barLike = true;
      }
    }
    (node.elements || []).forEach(walk);
  })(first);
  return (!hasH1 && widgets > 0 && widgets <= 7 && barLike) ? first : null;
}

/**
 * Deterministic header-spec enforcement: force tier background colors and the
 * verbatim CTA label from the analyzed reference onto the built header band.
 * Pushes a repair note when anything was corrected.
 */
function enforceHeaderSpec(page, spec) {
  const band = findHeaderBand(page.content);
  if (!band) return;
  const isHex = (h) => typeof h === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(h.trim());
  const tiers = Array.isArray(spec.tiers) ? spec.tiers : [];
  const tierRows = (Array.isArray(band.elements) ? band.elements : [])
    .filter((e) => e && e.elType === 'container');
  const rows = tierRows.length ? tierRows : [band];
  let fixedColors = 0;
  for (let i = 0; i < Math.min(rows.length, tiers.length); i++) {
    const bg = tiers[i] && String(tiers[i].background || '').trim();
    if (!isHex(bg)) continue; // 'transparent over hero' etc. — leave to the model
    if (!rows[i].settings || typeof rows[i].settings !== 'object') rows[i].settings = {};
    const rs = rows[i].settings;
    if (String(rs.background_color || '').toLowerCase() !== bg.toLowerCase()) {
      rs.background_background = 'classic';
      rs.background_color = bg;
      fixedColors++;
    }
  }
  let fixedCta = false;
  const label = spec.cta && typeof spec.cta.label === 'string' ? spec.cta.label.trim() : '';
  if (label && label.length <= 48) {
    let btn = null;
    (function walk(els) {
      for (const el of els || []) {
        if (btn) return;
        if (el && el.elType === 'widget' && el.widgetType === 'button') { btn = el; return; }
        if (el && Array.isArray(el.elements)) walk(el.elements);
      }
    })(band.elements);
    if (btn) {
      if (!btn.settings || typeof btn.settings !== 'object') btn.settings = {};
      if (String(btn.settings.text || '').trim().toLowerCase() !== label.toLowerCase()) {
        btn.settings.text = label;
        fixedCta = true;
      }
      // Sampled button colors/shape from the reference — enforced, not suggested.
      const fill = String(spec.cta.fill || '').trim();
      const txt = String(spec.cta.text_color || '').trim();
      if (isHex(fill) && String(btn.settings.background_color || '').toLowerCase() !== fill.toLowerCase()) {
        btn.settings.background_color = fill;
        fixedCta = true;
      }
      if (isHex(txt) && String(btn.settings.button_text_color || '').toLowerCase() !== txt.toLowerCase()) {
        btn.settings.button_text_color = txt;
        fixedCta = true;
      }
      const shape = String(spec.cta.shape || '').trim().toLowerCase();
      const radii = { sharp: '0', rounded: '8', pill: '50' };
      if (radii[shape] != null) {
        const r = radii[shape];
        btn.settings.border_radius = { unit: 'px', top: r, right: r, bottom: r, left: r, isLinked: true };
      }
    }
  }
  if (fixedColors || fixedCta) {
    const parts = [];
    if (fixedColors) parts.push(`${fixedColors} tier color(s)`);
    if (fixedCta) parts.push('CTA label');
    page._repairs.push(`Header corrected to the reference analysis (${parts.join(' + ')}).`);
  }
}

/* ------------------------------------------------------------
 * LOOP GRID (custom blog cards) — source-verified building blocks.
 * A loop-item template (the card) is created in the site's Elementor
 * library via the companion plugin (v1.4.0+); the page then uses the
 * native `loop-grid` widget referencing it. Dynamic tags wire the card's
 * widgets to each post's real title/image/date/excerpt/terms/URL.
 * ------------------------------------------------------------ */

/** 7-char lowercase-hex id (Elementor's own generator shape). */
function hexId() {
  let out = '';
  while (out.length < 7) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** Build an Elementor dynamic-tag shortcode: [elementor-tag id name settings]. */
function dynTag(name, settings) {
  const enc = encodeURIComponent(JSON.stringify(settings || {}));
  return `[elementor-tag id="${hexId()}" name="${name}" settings="${enc}"]`;
}

/**
 * Deterministic loop-item CARD skeleton: image → category → title → excerpt →
 * date → read-more, each wired to its post via __dynamic__. The model then
 * RESTYLES this to match the reference; the wiring itself never depends on
 * model compliance.
 */
function buildLoopCardSkeleton(designSystem) {
  const pal = (designSystem && designSystem.palette) || {};
  const accent = typeof pal.accent === 'string' ? pal.accent : '#333333';
  const headingColor = typeof pal.heading_text === 'string' ? pal.heading_text : '#1a1a1a';
  const bodyColor = typeof pal.body_text === 'string' ? pal.body_text : '#555555';
  const card = typeof pal.card === 'string' ? pal.card : '#ffffff';
  return {
    id: hexId(), elType: 'container', isInner: false,
    settings: {
      content_width: 'full',
      flex_direction: 'column',
      flex_gap: { column: '0', row: '12', isLinked: false, unit: 'px' },
      background_background: 'classic', background_color: card,
      border_radius: { unit: 'px', top: '12', right: '12', bottom: '12', left: '12', isLinked: true },
      padding: { unit: 'px', top: '0', right: '0', bottom: '20', left: '0', isLinked: false },
      overflow: 'hidden',
    },
    elements: [
      { id: hexId(), elType: 'widget', widgetType: 'image',
        settings: {
          image: { url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=800', id: '' },
          image_size: 'large',
          __dynamic__: { image: dynTag('post-featured-image') },
        }, elements: [] },
      { id: hexId(), elType: 'widget', widgetType: 'heading',
        settings: {
          title: 'Category', header_size: 'div', title_color: accent,
          typography_typography: 'custom',
          typography_font_size: { unit: 'px', size: 12, sizes: [] },
          typography_text_transform: 'uppercase',
          _padding: { unit: 'px', top: '0', right: '20', bottom: '0', left: '20', isLinked: false },
          __dynamic__: { title: dynTag('post-terms', { taxonomy: 'category' }) },
        }, elements: [] },
      { id: hexId(), elType: 'widget', widgetType: 'heading',
        settings: {
          title: 'Post Title Goes Here', header_size: 'h3', title_color: headingColor,
          link: { url: '#', is_external: '', nofollow: '', custom_attributes: '' },
          typography_typography: 'custom',
          typography_font_size: { unit: 'px', size: 20, sizes: [] },
          _padding: { unit: 'px', top: '0', right: '20', bottom: '0', left: '20', isLinked: false },
          __dynamic__: { title: dynTag('post-title'), link: dynTag('post-url') },
        }, elements: [] },
      { id: hexId(), elType: 'widget', widgetType: 'text-editor',
        settings: {
          editor: '<p>Post excerpt preview text…</p>',
          text_color: bodyColor,
          _padding: { unit: 'px', top: '0', right: '20', bottom: '0', left: '20', isLinked: false },
          __dynamic__: { editor: dynTag('post-excerpt', { max_length: 25 }) },
        }, elements: [] },
      { id: hexId(), elType: 'widget', widgetType: 'heading',
        settings: {
          title: 'June 1, 2026', header_size: 'div', title_color: bodyColor,
          typography_typography: 'custom',
          typography_font_size: { unit: 'px', size: 13, sizes: [] },
          _padding: { unit: 'px', top: '0', right: '20', bottom: '0', left: '20', isLinked: false },
          __dynamic__: { title: dynTag('post-date') },
        }, elements: [] },
      { id: hexId(), elType: 'widget', widgetType: 'button',
        settings: {
          text: 'Read More', button_text_color: accent,
          background_color: 'rgba(0,0,0,0)',
          border_border: 'solid',
          border_width: { unit: 'px', top: '1', right: '1', bottom: '1', left: '1', isLinked: true },
          border_color: accent,
          border_radius: { unit: 'px', top: '24', right: '24', bottom: '24', left: '24', isLinked: true },
          link: { url: '#', is_external: '', nofollow: '', custom_attributes: '' },
          selected_icon: { value: 'fas fa-chevron-right', library: 'fa-solid' },
          icon_align: 'right',
          _margin: { unit: 'px', top: '0', right: '20', bottom: '0', left: '20', isLinked: false },
          __dynamic__: { link: dynTag('post-url') },
        }, elements: [] },
    ],
  };
}

/** The dynamic bindings that must survive the styling pass. */
function loopCardBindingsIntact(card) {
  const s = JSON.stringify(card);
  // Note: inside stringified JSON the tag's quotes are escaped — match on the
  // tag names themselves plus the __dynamic__ marker.
  return s.includes('__dynamic__') &&
    s.includes('post-title') &&
    s.includes('post-url') &&
    s.includes('post-featured-image');
}

/** Native loop-grid widget pointing at the created card template. */
function buildLoopGridWidget(templateId, opts = {}) {
  return {
    id: hexId(), elType: 'widget', widgetType: 'loop-grid',
    settings: {
      template_id: templateId,
      columns: String(opts.columns || '3'),
      columns_tablet: '2',
      columns_mobile: '1',
      posts_per_page: Number(opts.postsPerPage || 3),
      equal_height: 'yes',
      post_query_post_type: 'post',
      pagination_type: '',
    },
    elements: [],
  };
}

/**
 * Native taxonomy-filter widget (Pro): LIVE category filter pills wired to a
 * loop-grid by its element id. Keys source-verified (modules/loop-filter).
 */
function buildTaxonomyFilterWidget(gridElementId, designSystem) {
  const pal = (designSystem && designSystem.palette) || {};
  const accent = typeof pal.accent === 'string' ? pal.accent : '#333333';
  const bodyColor = typeof pal.body_text === 'string' ? pal.body_text : '#555555';
  return {
    id: hexId(), elType: 'widget', widgetType: 'taxonomy-filter',
    settings: {
      selected_element: gridElementId,
      taxonomy: 'category',
      direction: 'horizontal',
      item_alignment_horizontal: 'center',
      show_first_item: 'yes',
      first_item_title: 'All Posts',
      taxonomy_filter_typography_typography: 'custom',
      taxonomy_filter_typography_font_size: { unit: 'px', size: 13, sizes: [] },
      taxonomy_filter_typography_font_weight: '600',
      taxonomy_filter_typography_text_transform: 'uppercase',
      taxonomy_filter_normal_text_color: bodyColor,
      taxonomy_filter_active_text_color: '#ffffff',
      taxonomy_filter_active_background_background: 'classic',
      taxonomy_filter_active_background_color: accent,
      taxonomy_filter_border_radius: { unit: 'px', top: '20', right: '20', bottom: '20', left: '20', isLinked: true },
      taxonomy_filter_padding: { unit: 'px', top: '8', right: '18', bottom: '8', left: '18', isLinked: false },
      taxonomy_filter_items_space_between: { unit: 'px', size: 8, sizes: [] },
    },
    elements: [],
  };
}

/**
 * When the pipeline adds the REAL taxonomy-filter, any model-built decorative
 * pill row (a container holding ONLY 2-5 buttons) in the same blog band is a
 * duplicate fake filter — remove it.
 */
function removeFakeFilterPills(band, repairs) {
  let removed = 0;
  (function walk(el) {
    if (!el || !Array.isArray(el.elements)) return;
    el.elements = el.elements.filter((child) => {
      if (child && child.elType === 'container' && Array.isArray(child.elements) &&
          child.elements.length >= 2 && child.elements.length <= 5 &&
          child.elements.every((c) => c && c.elType === 'widget' && c.widgetType === 'button')) {
        removed++;
        return false;
      }
      return true;
    });
    el.elements.forEach(walk);
  })(band);
  if (removed) repairs.push('Removed a decorative filter-pill row (the live category filter replaces it).');
  return removed;
}

/** Does the analyzed reference show filter pills/tabs above the blog grid? */
function referenceShowsBlogFilter(designSystem) {
  if (!designSystem) return false;
  const s = JSON.stringify(designSystem).toLowerCase();
  return /(all posts|filter (bar|tabs|pills)|category (tabs|pills|filter)|filter(able)? (posts|grid)|(recent|popular) posts tab)/.test(s);
}

/**
 * Deterministic price-table styling: a default grey price-table next to a
 * fully styled page is the fastest "AI built this" tell. Fill ONLY the keys
 * the model left unset, straight from the analyzed palette.
 */
function stylePriceTables(page, designSystem) {
  const pal = (designSystem && designSystem.palette) || {};
  const accent = typeof pal.accent === 'string' ? pal.accent : null;
  const dark = typeof pal.heading_text === 'string' ? pal.heading_text : null;
  if (!accent && !dark) return 0;
  let styled = 0;
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      if (el.elType === 'widget' && el.widgetType === 'price-table' &&
          el.settings && typeof el.settings === 'object') {
        const s = el.settings;
        let touched = false;
        // Elementor's default grey header (~#54595f) — or any near-grey the
        // model parroted from the default — counts as UNSTYLED.
        const b = hexBrightness(s.header_background_color);
        const nearGrey = (() => {
          const m = /^#([0-9a-f]{6})$/i.exec(String(s.header_background_color || '').trim());
          if (!m) return false;
          const n = parseInt(m[1], 16);
          const r = (n >> 16) & 255, g = (n >> 8) & 255, bl = n & 255;
          return (Math.max(r, g, bl) - Math.min(r, g, bl)) < 20 && b != null && b > 40 && b < 150;
        })();
        if (dark && (s.header_background_color == null || nearGrey)) { s.header_background_color = dark; touched = true; }
        if (s.header_background_color != null && s.heading_color == null) { s.heading_color = '#ffffff'; touched = true; }
        if (dark && s.price_color == null) { s.price_color = dark; touched = true; }
        if (accent && s.button_background_color == null) { s.button_background_color = accent; touched = true; }
        if (s.button_background_color != null && s.button_color == null) { s.button_color = '#ffffff'; touched = true; }
        // Ribbons: default green — whether omitted OR explicitly parroted —
        // never matches the page. Any ribbon color that is not one of the
        // page's own palette colors becomes the accent.
        if (accent && (s.show_ribbon != null || s.ribbon_title != null)) {
          const palSet = new Set(Object.values(pal)
            .filter((v) => typeof v === 'string').map((v) => v.toLowerCase()));
          const cur = String(s.ribbon_bg_color || '').toLowerCase();
          if (!cur || !palSet.has(cur)) {
            s.ribbon_bg_color = accent; s.ribbon_text_color = '#ffffff'; touched = true;
          }
        }
        if (touched) styled++;
      }
      if (Array.isArray(el.elements)) walk(el.elements);
    }
  })(page.content);
  if (styled) page._repairs.push(`${styled} price table(s) styled to the page palette (were default grey).`);
  return styled;
}


/** Perceived brightness (0-255) of a #rrggbb hex; null when unparseable. */
function hexBrightness(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (((n >> 16) & 255) * 299 + (((n >> 8) & 255) * 587) + ((n & 255) * 114)) / 1000;
}

/**
 * Deterministic SERVICE AREAS styling: the model keeps rendering city lists
 * as a cramped inline strip. Code rebuilds any long location icon-list into
 * wrapped ghost PILLS colored from the page itself — works for any design.
 */
function styleServiceAreas(page, designSystem) {
  const pal = (designSystem && designSystem.palette) || {};
  const accent = typeof pal.accent === 'string' ? pal.accent : '#666666';
  const bandRe = /service areas?|areas? we serve|locations? we|cities we|serving [a-z]/i;
  let styled = 0;
  for (const band of page.content) {
    let isAreas = false;
    (function scan(el) {
      if (isAreas || !el || typeof el !== 'object') return;
      if (el.widgetType === 'heading' && el.settings && bandRe.test(String(el.settings.title || ''))) isAreas = true;
      (el.elements || []).forEach(scan);
    })(band);
    if (!isAreas) continue;
    (function walk(el, parentBg) {
      if (!el || typeof el !== 'object') return;
      const bg = el.settings && typeof el.settings === 'object' && el.settings.background_color
        ? el.settings.background_color : parentBg;
      if (Array.isArray(el.elements)) {
        el.elements = el.elements.map((child) => {
          if (child && child.elType === 'widget' && child.widgetType === 'icon-list' &&
              child.settings && Array.isArray(child.settings.icon_list) &&
              child.settings.icon_list.length >= 6) {
            const dark = (hexBrightness(bg) ?? 255) < 128;
            const textColor = dark ? '#ffffff' : (typeof pal.heading_text === 'string' ? pal.heading_text : '#333333');
            const borderColor = dark ? 'rgba(255,255,255,0.35)' : accent;
            styled++;
            return {
              id: child.id || hexId(), elType: 'container', isInner: true,
              settings: {
                content_width: 'full',
                flex_direction: 'row', flex_wrap: 'wrap',
                flex_justify_content: 'center',
                flex_gap: { column: '12', row: '12', isLinked: true, unit: 'px' },
              },
              elements: child.settings.icon_list.map((item) => ({
                id: hexId(), elType: 'widget', widgetType: 'button',
                settings: {
                  text: String(item.text || '').trim() || 'Area',
                  ...(item.link && item.link.url ? { link: item.link } : {}),
                  button_text_color: textColor,
                  background_color: 'rgba(0,0,0,0)',
                  border_border: 'solid',
                  border_width: { unit: 'px', top: '1', right: '1', bottom: '1', left: '1', isLinked: true },
                  border_color: borderColor,
                  border_radius: { unit: 'px', top: '20', right: '20', bottom: '20', left: '20', isLinked: true },
                  text_padding: { unit: 'px', top: '8', right: '16', bottom: '8', left: '16', isLinked: false },
                  typography_typography: 'custom',
                  typography_font_size: { unit: 'px', size: 13, sizes: [] },
                  selected_icon: { value: 'fas fa-map-marker-alt', library: 'fa-solid' },
                  icon_align: 'left',
                  icon_indent: { unit: 'px', size: 6, sizes: [] },
                  button_background_hover_color: accent,
                  hover_color: '#ffffff',
                  _element_width: 'auto',
                },
                elements: [],
              })),
            };
          }
          return child;
        });
        el.elements.forEach((c) => walk(c, bg));
      }
    })(band, band.settings && band.settings.background_color);
    // Give the panel breathing room if it was cramped.
    (function pad(el) {
      if (!el || typeof el !== 'object') return;
      if (el.elType === 'container' && el.settings && el.settings.background_color &&
          (hexBrightness(el.settings.background_color) ?? 255) < 128) {
        if (el.settings.padding == null) {
          el.settings.padding = { unit: 'px', top: '36', right: '32', bottom: '36', left: '32', isLinked: false };
        }
        if (el.settings.border_radius == null) {
          el.settings.border_radius = { unit: 'px', top: '12', right: '12', bottom: '12', left: '12', isLinked: true };
        }
        return;
      }
      (el.elements || []).forEach(pad);
    })(band);
  }
  if (styled) page._repairs.push(`Service-areas list rebuilt as styled location pills (${styled} list(s)).`);
  return styled;
}

/**
 * Remove every top-level band whose subtree contains one of the given widget
 * types — used to DELETE invented sections (blog/gallery/pricing the
 * reference never showed) in code instead of hoping a critique pass obeys.
 */
function removeBandsWithWidget(page, widgetTypes, label) {
  const wanted = new Set(widgetTypes);
  const before = page.content.length;
  page.content = page.content.filter((band) => {
    let has = false;
    (function walk(el) {
      if (has || !el || typeof el !== 'object') return;
      if (el.elType === 'widget' && wanted.has(el.widgetType)) { has = true; return; }
      (el.elements || []).forEach(walk);
    })(band);
    return !has;
  });
  const removed = before - page.content.length;
  if (removed) {
    page._repairs.push(`Removed ${removed} invented ${label} section(s) — the reference does not show one.`);
  }
  return removed;
}

/**
 * Verify EXTERNAL image URLs actually resolve (the model hallucinates
 * Unsplash photo ids). Dead URLs are swapped for verified stock photos.
 * Runs when images were NOT sideloaded (sideload has its own fallback).
 */
async function verifyExternalImages(content, repairs, siteHost) {
  const FALLBACKS = [
    'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=1400&q=80&auto=format&fit=crop',
  ];
  const targets = [];
  collectImageRefs(content, targets);
  const urls = [...new Set(targets.map((t) => t.getUrl())
    .filter((u) => u && /^https?:\/\//i.test(u) && !(siteHost && u.includes(siteHost))))];
  const dead = new Set();
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) dead.add(url);
      } catch (_) { dead.add(url); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  if (!dead.size) return 0;
  let fb = 0;
  for (const t of targets) {
    const u = t.getUrl();
    if (u && dead.has(u)) {
      t.setMedia({ id: '', url: FALLBACKS[fb++ % FALLBACKS.length] });
    }
  }
  if (Array.isArray(repairs)) {
    repairs.push(`${dead.size} dead image URL(s) replaced with verified stock photos.`);
  }
  return dead.size;
}


/**
 * Point every nav-menu widget on the page at the given WP menu slug.
 * Returns how many were re-pointed.
 */
function setNavMenuSlug(content, slug) {
  let n = 0;
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      if (el.elType === 'widget' && el.widgetType === 'nav-menu') {
        if (!el.settings || typeof el.settings !== 'object') el.settings = {};
        el.settings.menu = slug;
        n++;
      }
      if (Array.isArray(el.elements)) walk(el.elements);
    }
  })(content);
  return n;
}

/**
 * Clean nav labels from the analyzed header spec (3-8 short strings).
 */
function extractNavItems(designSystem) {
  const items = designSystem && designSystem.header && Array.isArray(designSystem.header.nav_items)
    ? designSystem.header.nav_items : [];
  const clean = items
    .map((x) => String(x || '').trim())
    .filter((x) => x.length >= 2 && x.length <= 40 && !/^exact nav link/i.test(x));
  return clean.length >= 2 && clean.length <= 10 ? clean.slice(0, 8) : null;
}


/**
 * Derive a working palette from the BUILT page (prompt-only builds have no
 * analyzed design system) so the deterministic stylers still get colors:
 * accent = most-used saturated button fill; heading = most-used dark heading
 * color; card stays white.
 */
function derivePaletteFromPage(page) {
  const buttonFills = new Map();
  const headingColors = new Map();
  const bump = (map, v) => {
    const c = String(v || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c)) map.set(c, (map.get(c) || 0) + 1);
  };
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      const st = el.settings;
      if (el.elType === 'widget' && st && typeof st === 'object') {
        if (el.widgetType === 'button') bump(buttonFills, st.background_color);
        if (el.widgetType === 'heading') bump(headingColors, st.title_color);
      }
      if (Array.isArray(el.elements)) walk(el.elements);
    }
  })(page.content);
  const top = (map, pred) => {
    let best = null; let n = 0;
    for (const [c, cnt] of map) {
      if (pred && !pred(c)) continue;
      if (cnt > n) { best = c; n = cnt; }
    }
    return best;
  };
  const saturated = (hex) => {
    const v = parseInt(hex.slice(1), 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return (Math.max(r, g, b) - Math.min(r, g, b)) >= 40;
  };
  const dark = (hex) => (hexBrightness(hex) ?? 255) < 110;
  const accent = top(buttonFills, saturated) || top(buttonFills, null);
  const heading = top(headingColors, dark);
  if (!accent && !heading) return null;
  return { palette: { accent: accent || undefined, heading_text: heading || undefined, card: '#ffffff' } };
}


/**
 * Insert a (validated) section into a page's content with FRESH unique ids,
 * at the given index (default: before the last band — footers live last).
 * Returns the insert index used.
 */
function insertSectionWithFreshIds(targetContent, section, index) {
  (function reid(el) {
    if (!el || typeof el !== 'object') return;
    el.id = hexId();
    (el.elements || []).forEach(reid);
  })(section);
  const max = targetContent.length;
  let at = Number.isInteger(index) ? Math.max(0, Math.min(index, max)) : Math.max(0, max - 1);
  targetContent.splice(at, 0, section);
  dedupeIds(targetContent);
  return at;
}


/** Normalized text of a band's first heading (fallback: all its text). */
function bandHeadingText(band) {
  let heading = '';
  let all = '';
  (function walk(el) {
    if (!el || typeof el !== 'object') return;
    if (el.settings && typeof el.settings === 'object') {
      if (!heading && el.widgetType === 'heading' && el.settings.title) heading = String(el.settings.title);
      for (const k of ['title', 'editor', 'text']) {
        if (typeof el.settings[k] === 'string') all += ' ' + el.settings[k];
      }
    }
    (el.elements || []).forEach(walk);
  })(band);
  const norm = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]/g, '');
  return { heading: norm(heading), all: norm(all) };
}

/**
 * Find the target band that is "the same section" as the given one —
 * matched by first-heading similarity (variations share near-identical
 * headings). Returns the index or -1.
 */
function findMatchingBandIndex(targetContent, section) {
  const src = bandHeadingText(section);
  if (!src.heading || src.heading.length < 6) return -1;
  const grams = (t) => {
    const g = new Set();
    for (let i = 0; i <= t.length - 3; i++) g.add(t.slice(i, i + 3));
    return g;
  };
  const similar = (a, b) => {
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const ga = grams(a); const gb = grams(b);
    let hit = 0;
    for (const g of ga) if (gb.has(g)) hit++;
    return (2 * hit) / (ga.size + gb.size) >= 0.7;
  };
  for (let i = 0; i < targetContent.length; i++) {
    const t = bandHeadingText(targetContent[i]);
    if (similar(src.heading, t.heading)) return i;
  }
  return -1;
}

/**
 * Transplant a section into a page: REPLACE the matching section when one
 * exists (same heading), otherwise ADD it before the footer.
 * Returns { mode: 'replaced'|'added', at, replacedLabel }.
 */
function upsertSectionByMatch(targetContent, section) {
  const matchIdx = findMatchingBandIndex(targetContent, section);
  if (matchIdx >= 0) {
    targetContent.splice(matchIdx, 1);
    const at = insertSectionWithFreshIds(targetContent, section, matchIdx);
    return { mode: 'replaced', at };
  }
  const at = insertSectionWithFreshIds(targetContent, section, undefined);
  return { mode: 'added', at };
}

/** Replace the element with the given id ANYWHERE in the tree (band may be nested). */
function replaceElementById(content, id, replacement) {
  let done = false;
  (function walk(els) {
    for (let i = 0; i < (els || []).length && !done; i++) {
      const el = els[i];
      if (!el || typeof el !== 'object') continue;
      if (el.id === id) { els[i] = replacement; done = true; return; }
      if (Array.isArray(el.elements)) walk(el.elements);
    }
  })(content);
  return done;
}

/**
 * A spliced band is validated as its own one-element page, so its ids are
 * only unique within the band — regenerate any id that collides with the
 * rest of the page.
 */
function dedupeIds(content) {
  const seen = new Set();
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      if (el.id) {
        while (seen.has(el.id)) el.id = shortId();
        seen.add(el.id);
      }
      if (Array.isArray(el.elements)) walk(el.elements);
    }
  })(content);
}

/**
 * ------------------------------------------------------------
 * Person 7: walk the tree, sideload every external image URL,
 * replace with the returned { id, url }. Concurrency-limited.
 * Failures keep the original URL (never block publish).
 * ------------------------------------------------------------
 */
async function sideloadAndSwap(content, creds, wp, repairs) {
  const targets = [];
  collectImageRefs(content, targets);

  // Cache by URL so duplicates fetch once.
  const cache = new Map();
  const CONCURRENCY = 4;

  // Unique URLs that still need real attachment ids.
  const urls = [...new Set(
    targets
      .map((t) => t.getUrl())
      .filter((u) => u && /^https?:\/\//i.test(u))
  )];

  // The model sometimes HALLUCINATES Unsplash photo ids — those URLs 404 and
  // the page ships a broken image frame. When a sideload fails, retry with a
  // verified known-good stock photo so the page NEVER shows a dead image.
  const FALLBACK_POOL = [
    'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=1400&q=80&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=1400&q=80&auto=format&fit=crop',
  ];
  let fallbacks = 0;
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const media = await wp.sideloadMedia(creds, url);
        cache.set(url, media); // { id, url }
      } catch (_) {
        try {
          const fb = FALLBACK_POOL[fallbacks++ % FALLBACK_POOL.length];
          const media = await wp.sideloadMedia(creds, fb);
          cache.set(url, media); // dead URL replaced by a working stock photo
        } catch (_2) {
          cache.set(url, null); // total failure → keep original
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  if (fallbacks > 0 && Array.isArray(repairs)) {
    repairs.push(`${fallbacks} broken image URL(s) replaced with working stock photos.`);
  }

  // Apply swaps.
  for (const t of targets) {
    const media = cache.get(t.getUrl());
    if (media && media.id) t.setMedia(media);
  }
}

/** Find every image/gallery reference and expose get/set closures. */
function collectImageRefs(elements, out) {
  for (const el of elements) {
    const s = el.settings || {};

    // Single-image widgets (image, image-box, testimonial).
    if (s.image && typeof s.image === 'object' && (!s.image.id || s.image.id === '')) {
      out.push({
        getUrl: () => s.image.url,
        setMedia: (m) => { s.image.url = m.url; s.image.id = m.id; },
      });
    }

    // Gallery / carousel arrays (image-gallery uses `gallery`, image-carousel uses `carousel`).
    for (const key of ['gallery', 'carousel', 'wp_gallery']) {
      if (Array.isArray(s[key])) {
        s[key].forEach((item) => {
          if (item && (!item.id || item.id === '')) {
            out.push({
              getUrl: () => item.url,
              setMedia: (m) => { item.url = m.url; item.id = m.id; },
            });
          }
        });
      }
    }

    // Slide repeaters (slides / media-carousel / testimonial-carousel /
    // reviews): each item can carry `image` and/or `background_image`.
    // Without this walk, slide images were never resolved/sideloaded and
    // carousels published EMPTY (rendering as giant bare nav arrows).
    if (Array.isArray(s.slides)) {
      for (const item of s.slides) {
        if (!item || typeof item !== 'object') continue;
        for (const k of ['image', 'background_image']) {
          const img = item[k];
          if (img && typeof img === 'object' && (!img.id || img.id === '')) {
            out.push({
              getUrl: () => img.url,
              setMedia: (m) => { img.url = m.url; img.id = m.id; },
            });
          }
        }
      }
    }

    // Section/column background images.
    if (s.background_image && typeof s.background_image === 'object' &&
        (!s.background_image.id || s.background_image.id === '')) {
      out.push({
        getUrl: () => s.background_image.url,
        setMedia: (m) => { s.background_image.url = m.url; s.background_image.id = m.id; },
      });
    }

    if (Array.isArray(el.elements) && el.elements.length) {
      collectImageRefs(el.elements, out);
    }
  }
}

/**
 * ------------------------------------------------------------
 * Unsplash resolution: walk the tree (mirroring collectImageRefs)
 * and, for every image ref whose URL is empty OR clearly a guessed
 * stock/placeholder URL, look up a real photo via Unsplash using the
 * ref's alt text, the nearest heading, or prompt keywords as query.
 * Best-effort & concurrency-limited; never blocks publish.
 * ------------------------------------------------------------
 */
async function resolveUnsplashImages(content, accessKey, promptKeywords) {
  if (!accessKey) return;
  const refs = [];
  collectUnsplashRefs(content, refs, null);

  const fallback = String(promptKeywords || '').trim().slice(0, 80);
  const CONCURRENCY = 3;

  let i = 0;
  async function worker() {
    while (i < refs.length) {
      const ref = refs[i++];
      const url = ref.getUrl();
      // Keep real, already-hosted images.
      if (url && /^https?:\/\//i.test(url) && !isGuessedStock(url)) continue;

      const query = (ref.query && String(ref.query).trim()) || fallback;
      if (!query) continue;

      try {
        // Section backgrounds (heroes) need a genuinely WIDE photo.
        const found = await unsplashClient.searchImage(query, accessKey,
          ref.wide ? { width: 1920 } : {});
        if (found && found.url) ref.setUrl(found.url, found.alt);
      } catch (_) {
        // searchImage never throws, but stay defensive.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker)
  );
}

/**
 * Walk elements collecting image refs with a best-guess search query.
 * Tracks the nearest heading title seen while descending so a hero
 * image can inherit context from its section heading.
 */
function collectUnsplashRefs(elements, out, contextHeading) {
  let heading = contextHeading;
  for (const el of elements) {
    const s = el.settings || {};

    if (el.widgetType === 'heading' && s.title) {
      heading = String(s.title);
    }

    // Single-image widgets (image, image-box, testimonial, ...).
    if (s.image && typeof s.image === 'object') {
      const localHeading = heading;
      out.push({
        query: s.image.alt || localHeading,
        getUrl: () => s.image.url,
        setUrl: (u, alt) => {
          s.image.url = u;
          if (!s.image.id) s.image.id = '';
          if (alt && !s.image.alt) s.image.alt = alt;
        },
      });
    }

    // Gallery / carousel arrays (image-gallery uses `gallery`, image-carousel uses `carousel`).
    for (const key of ['gallery', 'carousel', 'wp_gallery']) {
      if (Array.isArray(s[key])) {
        const localHeading = heading;
        s[key].forEach((item) => {
          if (item && typeof item === 'object') {
            out.push({
              query: item.alt || localHeading,
              getUrl: () => item.url,
              setUrl: (u, alt) => {
                item.url = u;
                if (!item.id) item.id = '';
                if (alt && !item.alt) item.alt = alt;
              },
            });
          }
        });
      }
    }

    // Slide repeaters (slides / media-carousel / testimonial-carousel).
    if (Array.isArray(s.slides)) {
      const localHeading = heading;
      for (const item of s.slides) {
        if (!item || typeof item !== 'object') continue;
        for (const k of ['image', 'background_image']) {
          const img = item[k];
          if (img && typeof img === 'object') {
            out.push({
              query: img.alt || item.heading || item.name || localHeading,
              getUrl: () => img.url,
              setUrl: (u, alt) => {
                img.url = u;
                if (!img.id) img.id = '';
                if (alt && !img.alt) img.alt = alt;
              },
            });
          }
        }
      }
    }

    // Section/column background images — full-bleed, so ask for a WIDE photo.
    if (s.background_image && typeof s.background_image === 'object') {
      const localHeading = heading;
      out.push({
        query: localHeading,
        wide: true,
        getUrl: () => s.background_image.url,
        setUrl: (u) => {
          s.background_image.url = u;
          if (!s.background_image.id) s.background_image.id = '';
        },
      });
    }

    if (Array.isArray(el.elements) && el.elements.length) {
      collectUnsplashRefs(el.elements, out, heading);
    }
  }
}

/** True when any collected image ref points at an external http(s) URL. */
function hasExternalImageRefs(content) {
  const targets = [];
  collectImageRefs(content, targets);
  return targets.some((t) => {
    const u = t.getUrl();
    return u && /^https?:\/\//i.test(u);
  });
}

/** Heuristic: is this URL an empty/guessed/placeholder stock URL? */
function isGuessedStock(url) {
  if (!url) return true;
  return /(unsplash\.com|source\.unsplash|placehold|placeholder|via\.placeholder|picsum\.photos|lorempix|dummyimage|example\.(com|org|net)|your-?(site|domain|image))/i
    .test(url);
}

/**
 * ------------------------------------------------------------
 * Gemini resolution: for every image slot that needs an image
 * (empty id, or a guessed/placeholder URL), generate one with the
 * Gemini image model and upload the bytes straight into the WP
 * Media Library via core /wp/v2/media, then set {id,url} on the
 * ref. Capped at 8 generations/page; failures keep the existing
 * image so the page is never broken.
 * ------------------------------------------------------------
 */
async function resolveGeminiImages(content, geminiKey, creds, wp, promptKeywords) {
  if (!geminiKey) return 0;
  const slots = [];
  collectGeminiSlots(content, slots, null);
  // Gemini mode means EVERY image is AI-generated — no capped subset that
  // leaves the rest of the page on stock URLs. Hard ceiling of 40 is only a
  // runaway backstop, far above any real page.
  const need = slots.filter((sl) => sl.needs).slice(0, 40);
  const fallback = String(promptKeywords || '').trim().slice(0, 90);

  // Concurrency pool of 3: image generation dominates build time when run
  // strictly sequentially; three in flight cuts that to a third.
  const CONCURRENCY = 6;   // image calls are independent — more in flight
  const ATTEMPTS = 2;      // one retry for a transient blip, not four
  // Hard wall-clock budget for the whole image stage. Without it a page with
  // many slots x retries x 45s timeouts could run for 40+ minutes on its own.
  const BUDGET_MS = 8 * 60 * 1000;
  const deadline = Date.now() + BUDGET_MS;
  let generated = 0;
  let i = 0;
  async function worker() {
    while (i < need.length) {
      const sl = need[i++];
      const query = (sl.query && String(sl.query).trim()) || fallback || 'a professional marketing scene';
      if (Date.now() > deadline) break; // budget spent — stop starting new work
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        try {
          const img = await geminiImageClient.generateImage(query, geminiKey);
          if (!img) {
            if (Date.now() > deadline) break;
            // brief pause before retrying — quota blips clear in seconds
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          // Resize/compress for the web before it lands in the media library
          // (never throws — falls back to the original bytes on any failure).
          const opt = await optimizeImage(img.buffer, img.mime);
          const filename = 'eai-gen-' + Math.random().toString(36).slice(2, 9) + '.' + (opt.ext || img.ext || 'png');
          const media = await wp.uploadMedia(creds, opt.buffer, filename, opt.mime);
          if (media && media.id) {
            sl.setMedia({ id: media.id, url: media.url });
            sl.ok = true;
            generated++;
            break;
          }
        } catch (_) {
          // generate/upload error — retry
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, need.length) }, worker)
  );

  // STRICT Gemini-only mode: a slot that could not be generated after all
  // attempts is EMPTIED, never left pointing at a web/stock URL — the user
  // chose AI generation, so no external image URLs may survive.
  let stripped = 0;
  for (const sl of need) {
    if (!sl.ok) {
      sl.setMedia({ id: '', url: '' });
      stripped++;
    }
  }
  resolveGeminiImages.lastNeeded = need.length; // visibility for the caller
  resolveGeminiImages.lastStripped = stripped;
  return generated;
}

/** Walk elements collecting image slots {query, needs, setMedia} for Gemini. */
function collectGeminiSlots(elements, out, contextHeading) {
  let heading = contextHeading;
  for (const el of elements) {
    const s = el.settings || {};
    if (el.widgetType === 'heading' && s.title) heading = String(s.title);

    if (s.image && typeof s.image === 'object') {
      const h = heading;
      out.push({
        query: s.image.alt || h,
        needs: !s.image.id || s.image.id === '' || !s.image.url || isGuessedStock(s.image.url),
        setMedia: (m) => { s.image.url = m.url; s.image.id = m.id; },
      });
    }

    for (const key of ['gallery', 'carousel', 'wp_gallery']) {
      if (Array.isArray(s[key])) {
        const h = heading;
        s[key].forEach((item) => {
          if (item && typeof item === 'object') {
            out.push({
              query: item.alt || h,
              needs: !item.id || item.id === '' || !item.url || isGuessedStock(item.url),
              setMedia: (m) => { item.url = m.url; item.id = m.id; },
            });
          }
        });
      }
    }

    // Slide repeaters (slides / media-carousel / testimonial-carousel).
    if (Array.isArray(s.slides)) {
      const h = heading;
      for (const item of s.slides) {
        if (!item || typeof item !== 'object') continue;
        for (const k of ['image', 'background_image']) {
          const img = item[k];
          if (img && typeof img === 'object') {
            out.push({
              query: img.alt || item.heading || item.name || h,
              needs: !img.id || img.id === '' || !img.url || isGuessedStock(img.url),
              setMedia: (m) => { img.url = m.url; img.id = m.id; },
            });
          }
        }
      }
    }

    if (s.background_image && typeof s.background_image === 'object') {
      const h = heading;
      out.push({
        query: h || 'a clean background texture',
        needs: !s.background_image.id || s.background_image.id === '' ||
               !s.background_image.url || isGuessedStock(s.background_image.url),
        setMedia: (m) => { s.background_image.url = m.url; s.background_image.id = m.id; },
      });
    }

    if (Array.isArray(el.elements) && el.elements.length) {
      collectGeminiSlots(el.elements, out, heading);
    }
  }
}

function stripFences(text) {
  return String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

module.exports = {
  runPipeline, designLint, findHeaderBand, guessHeaderBand, dedupeIds,
  enforceHeaderSpec, buildLoopCardSkeleton, buildLoopGridWidget, loopCardBindingsIntact, dynTag,
  buildTaxonomyFilterWidget, referenceShowsBlogFilter, removeFakeFilterPills, stylePriceTables,
  removeBandsWithWidget, verifyExternalImages, styleServiceAreas, setNavMenuSlug, extractNavItems, derivePaletteFromPage,
  insertSectionWithFreshIds, upsertSectionByMatch, findMatchingBandIndex,
};
