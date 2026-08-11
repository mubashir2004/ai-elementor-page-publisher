/**
 * ============================================================
 * FILE: backend/validator.js
 * OWNER: Person 6 (Validator & Auto-Repair Engine)
 *
 * Turns raw Claude output into a guaranteed-valid, safe,
 * publishable page object. Includes a Claude-powered repair
 * loop for unparseable JSON.
 *
 * EXPORT:
 *   validateAndRepair(rawModelText, claudeClient, opts={})
 *     -> { title, page_settings, content, custom_css, _repairs }
 *   (throws a descriptive Error if unrecoverable)
 *
 *   opts.allowPro (default false) — when true, Elementor Pro
 *   widget types are also permitted. The "html" widget is NEVER
 *   allowed, regardless of allowPro.
 *
 *   opts.containerize (default false) — when true, legacy
 *   section/column layouts are deterministically converted to
 *   flexbox containers AFTER normalization (see containerizePage).
 *
 * Strip `_repairs` before sending to the plugin — it is for logs only.
 * ============================================================
 */

'use strict';

const MAX_PAGE_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_CSS_BYTES = 50 * 1024;        // 50 KB
// Local lenient repair handles the common cases (trailing commas, a truncated
// tail) instantly, so we only need a single slow model round-trip as a fallback.
const MAX_REPAIR_RETRIES = 1;

// The native/free Elementor widget types allowed to survive validation.
const FREE_WIDGET_WHITELIST = new Set([
  'heading', 'text-editor', 'button', 'image', 'image-box', 'icon',
  'icon-box', 'icon-list', 'counter', 'divider', 'spacer', 'tabs',
  'accordion', 'toggle', 'testimonial', 'star-rating', 'rating',
  'image-carousel', 'image-gallery', 'social-icons', 'google_maps',
  'video', 'progress', 'progress-bar', 'text-path', 'alert',
  // NOTE: 'menu-anchor' is deliberately ABSENT — the owner never wants
  // anchor widgets; the nav is a real WordPress menu (or none).
]);

// Elementor Pro widget types, only permitted when opts.allowPro is true.
const PRO_WIDGET_WHITELIST = new Set([
  'form', 'nav-menu', 'slides', 'price-table', 'price-list',
  'testimonial-carousel', 'call-to-action', 'flip-box', 'media-carousel',
  'posts', 'portfolio', 'animated-headline', 'countdown', 'share-buttons',
  'blockquote', 'gallery', 'lottie', 'hotspot', 'reviews',
  'table-of-contents', 'author-box', 'login', 'search', 'code-highlight',
  'progress-tracker',
  // Loop Builder: dynamic post grids driven by a loop-item template the
  // pipeline creates in the site's library (plugin v1.4.0+), plus the live
  // taxonomy filter bar that can be wired to a loop-grid.
  'loop-grid', 'taxonomy-filter',
  // Elementor Pro GLOBAL WIDGET embed — requires a valid numeric templateID
  // pointing at an existing elementor_library widget template (checked in
  // normalizeElement; embeds auto-sync site-wide when the template changes).
  'global',
]);

// Back-compat alias — historically the free set was the whole whitelist.
const WIDGET_WHITELIST = FREE_WIDGET_WHITELIST;

// The "html" widget is NEVER allowed, regardless of allowPro.
const NEVER_ALLOWED_WIDGETS = new Set(['html']);

/**
 * Build the effective whitelist for a given options object.
 */
function buildWhitelist(allowPro) {
  const set = new Set(FREE_WIDGET_WHITELIST);
  if (allowPro) {
    for (const w of PRO_WIDGET_WHITELIST) set.add(w);
  }
  return set;
}

/**
 * Main entry point.
 */
async function validateAndRepair(rawModelText, claudeClient, opts = {}) {
  const repairs = [];
  const allowPro = !!(opts && opts.allowPro);
  const containerize = !!(opts && opts.containerize);
  const whitelist = buildWhitelist(allowPro);

  // 1. Parse (with repair loop)
  const parsed = await parseWithRepair(rawModelText, claudeClient, repairs);

  // 2. Shape the top-level object
  const page = {
    title: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : 'AI Generated Page',
    page_settings:
      parsed.page_settings && typeof parsed.page_settings === 'object'
        ? parsed.page_settings
        : { hide_title: 'yes' },
    content: Array.isArray(parsed.content) ? parsed.content : [],
    custom_css: typeof parsed.custom_css === 'string' ? parsed.custom_css : '',
  };

  if (page.page_settings.hide_title == null) {
    page.page_settings.hide_title = 'yes';
  }

  if (page.content.length === 0) {
    throw new Error('Generated page has an empty content array — nothing to publish.');
  }

  // 3. Structural walk over every element
  const usedIds = new Set();
  page.content = page.content
    .filter((el) => isElement(el))
    .map((el) => {
      // Repair: stray top-level columns/widgets are recoverable — wrap them in
      // a default container BEFORE normalization (the container branch then
      // converts a wrapped column into a proper nested container).
      if (el.elType === 'column' || el.elType === 'widget') {
        repairs.push(`Wrapped top-level "${el.elType}" in a default container.`);
        el = { id: null, elType: 'container', isInner: false, settings: {}, elements: [el] };
      }
      return normalizeElement(el, usedIds, repairs, 'section', whitelist);
    })
    .filter(Boolean);

  // Top level: containers (primary, flexbox model) or sections (legacy fallback).
  page.content = page.content.filter((el) => {
    if (el.elType !== 'section' && el.elType !== 'container') {
      repairs.push(`Dropped top-level element of type "${el.elType}" (must be container or section).`);
      return false;
    }
    el.isInner = false; // top-level elements are never inner
    return true;
  });

  if (page.content.length === 0) {
    throw new Error('After validation no valid sections remained.');
  }

  // 3.5 Guaranteed containers: deterministically convert any remaining
  // legacy section/column layout into flexbox containers (opt-in).
  if (containerize) {
    containerizePage(page.content, repairs);
  }

  // 3.6 Desktop row normalization — runs for BOTH model-authored containers
  // and containerized ones. Fixes the desktop-wrap bug where a base
  // flex_wrap:'wrap' plus widths summing to ~100% + flex_gap made the last
  // column wrap BELOW on desktop.
  normalizeRowContainers(page.content, repairs);

  // 3.62 Testimonial sliders are BANNED (owner's rule): convert any
  // testimonial-carousel/reviews widget into a row of static `testimonial`
  // widgets — every quote preserved, zero slider scripts.
  convertTestimonialSliders(page.content, repairs);

  // 3.63 Duplicate topbar strips: same utility strip emitted twice.
  dedupeTopbarStrips(page.content, repairs);

  // 3.64 ONE header per page: the model sometimes builds TWO header groups
  // (each with its own logo/CTA/nav). Keep the FIRST band containing a
  // nav-menu; any other nav-carrying band near the top is a duplicate header
  // and is removed whole (a nav deep in a trailing footer band only loses
  // the nav widget, not the band).
  dedupeHeaderBands(page.content, repairs);

  // 3.65 Header one-row enforcement — the whole header subtree (html_tag
  // "header" wrapper, or any row containing a nav-menu) stays ONE row on
  // every device. Undoes any mobile wrap/stacking injected above or authored
  // by the model.
  enforceHeaderRows(page.content);

  // 3.67 Entrance/scroll animations are BANNED: they depend on a JS trigger
  // that cached/optimized hosts routinely defer or break — Elementor then
  // leaves the section PERMANENTLY INVISIBLE on the live page. Pure-CSS
  // hover polish carries the interaction design instead.
  stripEntranceAnimations(page.content, repairs);

  // 3.68 Hover polish (deterministic): buttons darken on hover, card
  // containers lift with a shadow — pure CSS, injected only where the model
  // set nothing. Header band and forms are never touched.
  injectHoverPolish(page.content, repairs);

  // 3.69 Baseline usability floor (evidence-driven from generation history):
  // every nav-menu gets a complete mobile burger config (31/80 shipped
  // without one — phones got NO navigation), carousels get visible nav
  // controls (Elementor defaults render near-invisible), and body text
  // never ships below readable size.
  enforceUsabilityFloor(page.content, repairs);

  // 3.7 Menu-anchor cleanup: drop anchors nothing links to (and duplicates).
  // Skippable (cleanupAnchors:false) for single-element validation, where the
  // rest of the page — and its anchor links — is not visible.
  if (!opts || opts.cleanupAnchors !== false) {
    cleanupMenuAnchors(page.content, repairs);
  }

  // 4. Sanitize custom CSS
  page.custom_css = sanitizeCss(page.custom_css, repairs);

  // 5. Size guard
  const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
  if (bytes > MAX_PAGE_BYTES) {
    throw new Error(`Generated page is too large (${(bytes / 1048576).toFixed(2)} MB > 3 MB).`);
  }

  page._repairs = repairs;
  return page;
}

/**
 * ------------------------------------------------------------
 * Parse stage with Claude repair retries.
 * ------------------------------------------------------------
 */
async function parseWithRepair(rawText, claudeClient, repairs) {
  let candidate = stripFences(rawText);

  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    repairs.push(`Initial JSON.parse failed: ${firstErr.message}`);
  }

  // Try to salvage by slicing to the outermost braces before asking Claude.
  const sliced = sliceOuterObject(candidate);
  if (sliced) {
    try {
      const val = JSON.parse(sliced);
      repairs.push('Recovered JSON by slicing to outermost object.');
      return val;
    } catch (_) {
      /* fall through to local repair */
    }
  }

  // Local lenient repair (no model round-trip): strip trailing commas and
  // balance any brackets/strings left open by a truncated tail.
  const local = tryLocalRepair(candidate);
  if (local) {
    try {
      const val = JSON.parse(local);
      repairs.push('Recovered JSON via local lenient repair.');
      return val;
    } catch (_) {
      /* fall through to model repair */
    }
  }

  // Model-assisted repair loop.
  let lastErr = 'unknown parse error';
  for (let attempt = 1; attempt <= MAX_REPAIR_RETRIES; attempt++) {
    const fixed = await claudeClient.repairJson(candidate, lastErr);
    candidate = stripFences(fixed);
    try {
      const val = JSON.parse(candidate);
      repairs.push(`JSON repaired by Claude on attempt ${attempt}.`);
      return val;
    } catch (err) {
      lastErr = err.message;
      repairs.push(`Repair attempt ${attempt} still invalid: ${err.message}`);
    }
  }

  const e = new Error('Could not obtain valid JSON after repair attempts.');
  e.rawOutput = rawText; // preserve for the UI download-raw action
  throw e;
}

/**
 * ------------------------------------------------------------
 * Recursive element normalizer.
 * ------------------------------------------------------------
 */
function normalizeElement(el, usedIds, repairs, expectedType, whitelist) {
  // Guarantee shape.
  if (!el.settings || typeof el.settings !== 'object') el.settings = {};
  if (!Array.isArray(el.elements)) el.elements = [];

  // Unique id.
  el.id = ensureUniqueId(el.id, usedIds);

  const type = el.elType;

  if (type === 'widget') {
    // Whitelist enforcement. "html" is never allowed even if whitelisted.
    if (NEVER_ALLOWED_WIDGETS.has(el.widgetType) || !whitelist.has(el.widgetType)) {
      repairs.push(`Dropped disallowed widget "${el.widgetType}".`);
      return null;
    }
    // A global-widget embed is only valid with a real numeric templateID —
    // a made-up/missing id would render nothing on the site.
    if (el.widgetType === 'global') {
      const tid = el.templateID != null ? el.templateID : (el.settings && el.settings.templateID);
      if (!/^\d+$/.test(String(tid))) {
        repairs.push('Dropped a global-widget embed without a valid numeric templateID.');
        return null;
      }
      el.templateID = Number(tid);
    }
    normalizeWidgetSettings(el, repairs);
    // EMPTY-CAROUSEL GUARD: a carousel/gallery/slides widget with no items
    // publishes as bare oversized navigation arrows (a broken-looking band).
    // Drop it instead — the repair note tells the model/user what happened.
    const CAROUSEL_ITEMS_KEY = {
      'image-carousel': 'carousel',
      'image-gallery': 'wp_gallery',
      gallery: 'gallery',
      slides: 'slides',
      'media-carousel': 'slides',
      'testimonial-carousel': 'slides',
      reviews: 'slides',
    };
    const itemsKey = CAROUSEL_ITEMS_KEY[el.widgetType];
    if (itemsKey) {
      const items = el.settings && el.settings[itemsKey];
      if (!Array.isArray(items) || items.length === 0) {
        repairs.push(`Dropped an EMPTY ${el.widgetType} widget (no ${itemsKey} items — would render as bare arrows).`);
        return null;
      }
      // media-carousel is IMAGE-driven: a slide without an image renders as
      // a blank frame + oversized arrows. Every slide must carry an image URL.
      if (el.widgetType === 'media-carousel') {
        const ok = items.every((it) => it && it.image && typeof it.image === 'object' && it.image.url);
        if (!ok) {
          repairs.push('Dropped a media-carousel whose slides lack images (would render as blank frames + bare arrows). Build video/photo testimonial cards as styled containers instead.');
          return null;
        }
      }
      // testimonial-carousel needs real quote content on each slide.
      if (el.widgetType === 'testimonial-carousel') {
        const withContent = items.filter((it) => it && typeof it.content === 'string' && it.content.trim());
        if (withContent.length < 2) {
          repairs.push('Dropped a testimonial-carousel without at least 2 quote slides.');
          return null;
        }
      }
    }
    // Invisible-icon guard: in stacked/framed icon views, primary_color is
    // the SHAPE and secondary_color is the GLYPH. The model regularly sets
    // both to the brand color — a solid square with an invisible icon.
    if ((el.widgetType === 'icon-box' || el.widgetType === 'icon') &&
        el.settings && typeof el.settings === 'object') {
      const st = el.settings;
      const view = st.view;
      if ((view === 'stacked' || view === 'framed') &&
          typeof st.primary_color === 'string' && typeof st.secondary_color === 'string' &&
          st.primary_color.trim().toLowerCase() === st.secondary_color.trim().toLowerCase()) {
        st.secondary_color = '#ffffff';
        pushOnce(repairs, 'Icon contrast fixed: glyph color matched its shape color (made the glyph white).');
      }
    }

    // Price-table: Elementor's DEFAULT "Additional Info" line ("This is a
    // text element…") ships under every plan unless explicitly cleared —
    // classic unprofessional default leakage. Clear it unless the model wrote
    // real microcopy.
    if (el.widgetType === 'price-table' && el.settings && typeof el.settings === 'object') {
      const info = String(el.settings.footer_additional_info || '');
      if (info === '' || /this is (a )?text element/i.test(info)) {
        el.settings.footer_additional_info = '';
      }
    }

    // Counter numbers keep their desktop px size on phones when no mobile
    // size is set — huge digits overlap the neighboring stat. Clamp DOWN only:
    // a phone-safe desktop size stays untouched, non-px units are left alone
    // (we can't know their rendered px), and the clamp never enlarges.
    if (el.widgetType === 'counter' && el.settings && typeof el.settings === 'object') {
      const st = el.settings;
      if (st.typography_number_font_size_mobile == null) {
        const desk = st.typography_number_font_size;
        const isPx = desk && typeof desk === 'object' && (!desk.unit || desk.unit === 'px');
        if (desk == null) {
          // No explicit size at all: Elementor's default digits are huge.
          st.typography_number_typography = 'custom';
          st.typography_number_font_size_mobile = { unit: 'px', size: 40, sizes: [] };
        } else if (isPx && Number(desk.size) > 44) {
          st.typography_number_typography = 'custom';
          st.typography_number_font_size_mobile = {
            unit: 'px',
            size: Math.min(44, Math.max(30, Math.round(Number(desk.size) * 0.55))),
            sizes: [],
          };
        }
      }
    }
    el.elements = []; // widgets never have children
    return el;
  }

  if (type === 'container') {
    // Mobile safety net: a row container that cannot wrap breaks phone
    // layouts — sized children have nowhere to stack. Wrap is applied on
    // MOBILE ONLY (flex_wrap_mobile); a base flex_wrap would make ~100%-sum
    // rows wrap on desktop too (the desktop-wrap bug). Grids that must wrap
    // on desktop get their base flex_wrap from normalizeRowContainer. Note
    // pushed once per page (not per element) to keep repair logs small.
    const dir = el.settings.flex_direction;
    // HEADER EXCEPTION: a header row (contains a nav-menu, or html_tag
    // "header") must STAY one row on mobile — logo left, hamburger right.
    // Wrapping it stacks the logo/menu/CTA vertically (broken mobile header).
    const isHeaderRow = el.settings.html_tag === 'header' || containsWidget(el, 'nav-menu');
    if ((dir === 'row' || dir === 'row-reverse') && el.settings.flex_wrap_mobile == null && !isHeaderRow) {
      el.settings.flex_wrap_mobile = 'wrap';
      pushOnce(repairs, 'Mobile safety net: added flex_wrap_mobile:"wrap" to row containers missing it.');
    }
    if (isHeaderRow && (dir === 'row' || dir === 'row-reverse')) {
      // Keep the header a spaced single row on every device.
      if (el.settings.flex_wrap_mobile === 'wrap') delete el.settings.flex_wrap_mobile;
      if (el.settings.flex_justify_content == null) el.settings.flex_justify_content = 'space-between';
      if (el.settings.flex_align_items == null) el.settings.flex_align_items = 'center';
      pushOnce(repairs, 'Header row kept as a single spaced row on all devices (no mobile wrap).');
    }

    // Containers hold widgets and/or nested containers (flexbox model).
    // A stray legacy column inside a container is converted to a container.
    el.elements = el.elements
      .filter(isElement)
      .map((child) => {
        if (child.elType === 'column') {
          repairs.push('Converted a column inside a container into a nested container.');
          const size = child.settings && (child.settings._inline_size || child.settings._column_size);
          child.elType = 'container';
          child.isInner = true;
          if (child.settings) {
            delete child.settings._column_size;
            delete child.settings._inline_size;
            if (size && child.settings.width == null) {
              child.settings.width = { unit: '%', size: Number(size), sizes: [] };
            }
          }
        }
        if (child.elType === 'section') {
          // Sections can't live inside containers — flatten to a container.
          // A section lays its columns out in a ROW; preserve that axis.
          repairs.push('Converted a section inside a container into a nested container.');
          child.elType = 'container';
          child.isInner = true;
          if (!child.settings || typeof child.settings !== 'object') child.settings = {};
          if (child.settings.flex_direction == null) child.settings.flex_direction = 'row';
        }
        if (child.elType === 'container') {
          child.isInner = true;
          // Elementor ignores a child container's `width` unless that child
          // also has content_width:"full" — inject it so sized children work.
          if (child.settings && typeof child.settings === 'object' &&
              child.settings.width != null && child.settings.content_width == null) {
            child.settings.content_width = 'full';
          }
          // Mobile safety net: a child container sized below 100% must snap
          // to full width on phones. Skipped inside header rows — those stay
          // a single compact row on mobile — and inside rows the model marked
          // flex_wrap_mobile:"nowrap" (deliberate one-row-on-phone intent,
          // e.g. comparison tables). Note pushed once per page.
          const keepOneRow = isHeaderRow || el.settings.flex_wrap_mobile === 'nowrap';
          if (child.settings && typeof child.settings === 'object' && !keepOneRow) {
            const w = child.settings.width;
            if (w && typeof w === 'object' && (!w.unit || w.unit === '%') &&
                Number(w.size) > 0 && Number(w.size) < 100 &&
                child.settings.width_mobile == null) {
              child.settings.width_mobile = { unit: '%', size: 100, sizes: [] };
              pushOnce(repairs, 'Mobile safety net: added width_mobile:100% to sized child containers.');
            }
            // Stacked children read broken when left-hugging on phones
            // (counters/stats especially) — center them on mobile unless the
            // model explicitly chose an alignment.
            if (w && typeof w === 'object' && (!w.unit || w.unit === '%') &&
                Number(w.size) > 0 && Number(w.size) < 100 &&
                child.settings.flex_align_items_mobile == null) {
              child.settings.flex_align_items_mobile = 'center';
              pushOnce(repairs, 'Mobile safety net: centered stacked child containers on mobile (flex_align_items_mobile).');
            }
          }
        }
        return normalizeElement(child, usedIds, repairs, 'child', whitelist);
      })
      .filter(Boolean);
    // Empty child containers are legitimate flex spacers; keep them.
    return el;
  }

  if (type === 'section') {
    // Sections contain only columns.
    el.elements = el.elements
      .filter(isElement)
      .map((child) => {
        if (child.elType !== 'column') {
          repairs.push(`Wrapped a non-column child of a section into a column.`);
          return wrapInColumn(child, usedIds, repairs, whitelist);
        }
        return normalizeElement(child, usedIds, repairs, 'column', whitelist);
      })
      .filter(Boolean);
    if (el.elements.length === 0) {
      repairs.push('Removed a section that ended up with no columns.');
      return null;
    }
    return el;
  }

  if (type === 'column') {
    // Columns contain widgets or inner sections.
    el.elements = el.elements
      .filter(isElement)
      .map((child) => {
        if (child.elType === 'section') child.isInner = true;
        const norm = normalizeElement(child, usedIds, repairs, 'child', whitelist);
        return norm;
      })
      .filter(Boolean);
    // Ensure a column size exists.
    if (el.settings._column_size == null) el.settings._column_size = 100;
    return el;
  }

  // Unknown elType — drop.
  repairs.push(`Dropped element with unknown elType "${type}".`);
  return null;
}

/** True when the element or ANY descendant is a widget of the given type. */
function containsWidget(el, widgetType) {
  if (!el || typeof el !== 'object') return false;
  if (el.elType === 'widget' && el.widgetType === widgetType) return true;
  if (!Array.isArray(el.elements)) return false;
  return el.elements.some((child) => containsWidget(child, widgetType));
}

function normalizeWidgetSettings(el, repairs) {
  const s = el.settings;

  // Normalize image objects on any widget that carries one.
  if (s.image !== undefined) s.image = normalizeImage(s.image);

  // image-box / testimonial also use `image`. The three gallery-array keys:
  // image-gallery -> `wp_gallery`, image-carousel -> `carousel`, Pro gallery -> `gallery`.
  // Normalize them all identically (string -> {id:'',url}, drop null/url-less items).
  for (const key of ['gallery', 'carousel', 'wp_gallery']) {
    if (Array.isArray(s[key])) {
      s[key] = s[key].map(normalizeGalleryItem).filter(Boolean);
    }
  }

  // Slide repeaters (slides / media-carousel / testimonial-carousel / reviews):
  // drop null items, normalize each slide's image/background_image object,
  // ensure unique _id — so the image pipeline can resolve/sideload them.
  if (Array.isArray(s.slides)) {
    const seen = new Set();
    s.slides = s.slides.filter((it) => it && typeof it === 'object');
    for (const item of s.slides) {
      if (!item._id || seen.has(item._id)) item._id = shortId();
      seen.add(item._id);
      for (const k of ['image', 'background_image']) {
        if (item[k] !== undefined) item[k] = normalizeImage(item[k]);
      }
    }
  }

  // Ensure repeater items have unique _id (icon_list, tabs, social_icon_list).
  ['icon_list', 'tabs', 'social_icon_list'].forEach((key) => {
    if (Array.isArray(s[key])) {
      const seen = new Set();
      s[key].forEach((item, i) => {
        if (!item || typeof item !== 'object') return;
        if (!item._id || seen.has(item._id)) {
          item._id = shortId();
        }
        seen.add(item._id);
      });
    }
  });
}

/**
 * ------------------------------------------------------------
 * Guaranteed containers: deterministic legacy -> flexbox converter.
 *
 * Despite prompt instructions the model still often emits legacy
 * section/column pages. This converts them, in place:
 *   section -> container (flex row, wrapping, boxed/full width)
 *   column  -> child container (isInner, % width, stacks on mobile)
 *   inner sections recursively the same (isInner: true)
 * Widgets are untouched. Runs AFTER normalizeElement, so the tree
 * shape (sections contain only columns) is already guaranteed.
 * Pushes a single repair note for the whole page.
 * ------------------------------------------------------------
 */
function containerizePage(content, repairs) {
  let converted = 0;
  const posMap = { top: 'flex-start', center: 'center', middle: 'center', bottom: 'flex-end' };

  function sectionToContainer(sec, isInner) {
    converted++;
    const s = (sec.settings && typeof sec.settings === 'object') ? sec.settings : {};
    const settings = Object.assign({}, s);

    // Section gap:'no' means zero gutters; everything else gets the default 20px.
    const gap = s.gap === 'no' ? '0' : '20';
    settings.flex_direction = 'row';
    // Wrap on MOBILE only — a base flex_wrap makes ~100%-sum rows wrap on
    // desktop (the desktop-wrap bug). Multi-row grids (widths summing > 106)
    // get their base flex_wrap restored by normalizeRowContainer afterwards.
    settings.flex_wrap_mobile = 'wrap';
    settings.flex_gap = { column: gap, row: gap, isLinked: true, unit: 'px' };
    settings.content_width = s.layout === 'full_width' ? 'full' : 'boxed';
    delete settings.layout;
    delete settings.gap;

    // Preserve hero heights: legacy height:'min-height' + custom_height maps
    // onto the container's min_height (originals are kept too — harmless).
    if (s.height === 'min-height' && s.custom_height && settings.min_height == null) {
      settings.min_height = s.custom_height;
    }
    // All other settings (background_*, background_overlay_*, padding, margin,
    // border_*, box_shadow_*, shape_divider_*, min-height keys) are kept as-is
    // via the Object.assign copy above.

    sec.elType = 'container';
    sec.isInner = !!isInner;
    sec.settings = settings;
    sec.elements = (Array.isArray(sec.elements) ? sec.elements : []).map((child) => {
      if (child && child.elType === 'column') return columnToContainer(child);
      return child; // defensive: normalization already guarantees columns here
    });
    return sec;
  }

  function columnToContainer(col) {
    converted++;
    const s = (col.settings && typeof col.settings === 'object') ? col.settings : {};
    const settings = Object.assign({}, s);

    const size = Number(s._inline_size || s._column_size) || 100;
    delete settings._column_size;
    delete settings._inline_size;
    settings.content_width = 'full';
    settings.width = { unit: '%', size, sizes: [] };
    if (settings.width_mobile == null) {
      settings.width_mobile = { unit: '%', size: 100, sizes: [] };
    }
    settings.flex_direction = 'column';
    if (s.content_position && posMap[s.content_position]) {
      settings.flex_justify_content = posMap[s.content_position];
      delete settings.content_position;
    }

    col.elType = 'container';
    col.isInner = true;
    col.settings = settings;
    col.elements = (Array.isArray(col.elements) ? col.elements : []).map((child) => {
      // Inner sections convert recursively; widgets and containers untouched.
      if (child && child.elType === 'section') return sectionToContainer(child, true);
      return child;
    });
    return col;
  }

  for (const el of content) {
    if (el && el.elType === 'section') sectionToContainer(el, false);
  }

  if (converted > 0) {
    repairs.push(`Containerized legacy layout: converted ${converted} section/column element${converted === 1 ? '' : 's'} to flex containers.`);
  }
  return content;
}

/**
 * ------------------------------------------------------------
 * Desktop row normalization.
 *
 * Two sources used to inject a BASE flex_wrap:'wrap' onto row containers
 * (containerizePage + the mobile safety net). With 2 children whose widths
 * sum to ~100% plus a flex_gap, the flex line overflows by the gap width and
 * the SECOND child wraps below on DESKTOP. Fix deterministically:
 *   - single-row intent (2-4 % children, widths summing 90..106):
 *     remove the base flex_wrap, wrap on mobile only, and scale the widths
 *     to 96.5% of the row so it fits WITH gaps on desktop.
 *   - intentional multi-row grid (sum > 106, e.g. 6 cards at 31%):
 *     keep/restore the base flex_wrap:'wrap' (grids must wrap on desktop)
 *     and make sure children stack to 100% on phones.
 * Non-% widths are never touched.
 * ------------------------------------------------------------
 */
function normalizeRowContainer(el, repairs) {
  if (!el || el.elType !== 'container') return 0;
  if (!el.settings || typeof el.settings !== 'object') return 0;
  const s = el.settings;
  const dir = s.flex_direction;
  if (dir !== 'row' && dir !== 'row-reverse') return 0;
  // Header rows (logo | nav | CTA) must stay ONE row on every device —
  // never inject mobile wrap/stacking here (mirrors the safety-net exception).
  if (s.html_tag === 'header' || containsWidget(el, 'nav-menu')) return 0;

  // WIDGET row (stats / trust badges / feature strips): visual widgets sit
  // DIRECTLY in a row container. The owner's professional template kits NEVER
  // do this — every repeated item lives in its OWN child container (column,
  // centered, tight inner gap). Bare widgets overlap and misalign. Wrap them.
  const WIDGET_ROW_TYPES = new Set(['icon-box', 'image-box', 'counter', 'testimonial', 'image', 'icon']);
  const kids = Array.isArray(el.elements) ? el.elements : [];
  if (kids.length >= 2 && kids.every((c) => c && c.elType === 'widget' && WIDGET_ROW_TYPES.has(c.widgetType))) {
    const n = kids.length;
    // 3-4 per row; 5+ items become a wrapping 3-up grid (pro kits never cram
    // 5-6 stats into one line — that is where numbers start overlapping).
    const perRow = n <= 4 ? n : 3;
    const size = Math.round((96 / perRow) * 10) / 10;
    if (n <= 4) delete s.flex_wrap; else s.flex_wrap = 'wrap';
    if (s.flex_wrap_mobile == null) s.flex_wrap_mobile = 'wrap';
    if (s.flex_justify_content == null) s.flex_justify_content = 'center';
    const compact = kids.every((c) => c.widgetType === 'counter' || c.widgetType === 'icon');
    el.elements = kids.map((w) => ({
      id: shortId(), elType: 'container', isInner: true,
      settings: {
        content_width: 'full',
        width: { unit: '%', size, sizes: [] },
        width_mobile: { unit: '%', size: compact ? 46 : 100, sizes: [] },
        flex_direction: 'column',
        flex_align_items: 'center',
        flex_gap: { column: '0', row: '10', isLinked: false, unit: 'px' },
      },
      elements: [w],
    }));
    void repairs; // page-level note pushed by normalizeRowContainers
    return 1;
  }

  const isPctWidth = (w) => !!(w && typeof w === 'object' &&
    (!w.unit || w.unit === '%') && Number(w.size) > 0);
  const pctChildren = (Array.isArray(el.elements) ? el.elements : []).filter(
    (c) => c && c.elType === 'container' && c.settings &&
      typeof c.settings === 'object' && isPctWidth(c.settings.width)
  );
  if (pctChildren.length < 2) return 0;

  const sum = pctChildren.reduce((acc, c) => acc + Number(c.settings.width.size), 0);
  const ensureMobileFull = (c) => {
    if (c.settings.width_mobile == null) {
      c.settings.width_mobile = { unit: '%', size: 100, sizes: [] };
    }
  };
  // Model-authored 2-up mobile intent that cannot FIT: 47%+47% + the flex gap
  // exceeds 100%, so pairs wrap into narrow single cards with a huge empty
  // right side. Fit the pair (46%) or stack anything wider than half.
  const clampMobilePair = (c) => {
    const wm = c.settings.width_mobile;
    if (wm && typeof wm === 'object' && (!wm.unit || wm.unit === '%')) {
      const size = Number(wm.size);
      if (size > 46 && size <= 52) wm.size = 46;
      else if (size > 52 && size < 100) wm.size = 100;
    }
  };

  if (pctChildren.length <= 4 && sum >= 90 && sum <= 106) {
    // Single-row intent: never wrap on desktop; wrap (stack) on mobile only —
    // unless the model explicitly marked the row nowrap-on-mobile (deliberate
    // one-row-on-phone intent, e.g. comparison tables keep their columns).
    const explicitNoWrap = s.flex_wrap_mobile === 'nowrap';
    delete s.flex_wrap;
    if (s.flex_wrap_mobile == null) s.flex_wrap_mobile = 'wrap';
    for (const c of pctChildren) {
      const w = c.settings.width;
      // Fit the row WITH gaps: scale to 96.5% of the row, 1-decimal precision.
      w.size = Math.round((Number(w.size) * 96.5 / sum) * 10) / 10;
      if (!explicitNoWrap) { ensureMobileFull(c); clampMobilePair(c); }
    }
    void repairs; // per-page note is pushed once by normalizeRowContainers
    return 1;
  }

  if (sum > 106) {
    // Intentional multi-row grid: it MUST wrap on desktop too.
    s.flex_wrap = 'wrap';
    for (const c of pctChildren) {
      if (Number(c.settings.width.size) < 100) ensureMobileFull(c);
      clampMobilePair(c);
    }
  }
  return 0;
}

/**
 * ------------------------------------------------------------
 * Header one-row enforcement (step 3.65).
 * Header scope = any container with html_tag:"header" (and its whole
 * subtree) + any row container that contains a nav-menu widget.
 * Inside the scope:
 *   - row containers lose flex_wrap_mobile (a header NEVER stacks) and get
 *     space-between / center alignment defaults;
 *   - children lose a width_mobile of 100% (injected stacking) so the
 *     logo | nav | CTA stay side by side on phones.
 * ------------------------------------------------------------
 */
function enforceHeaderRows(content) {
  const fixRow = (el) => {
    const s = el.settings;
    const dir = s.flex_direction;
    if (dir === 'row' || dir === 'row-reverse') {
      // Elementor containers STACK on mobile BY DEFAULT (its own stylesheet
      // wraps rows and makes children full-width at the mobile breakpoint).
      // Deleting keys is NOT enough — the header needs EXPLICIT overrides.
      delete s.flex_wrap;
      s.flex_wrap_mobile = 'nowrap';
      s.flex_wrap_tablet = 'nowrap';
      if (s.flex_direction_mobile && s.flex_direction_mobile !== dir) delete s.flex_direction_mobile;
      if (s.flex_direction_tablet && s.flex_direction_tablet !== dir) delete s.flex_direction_tablet;
      if (s.flex_justify_content == null) s.flex_justify_content = 'space-between';
      if (s.flex_align_items == null) s.flex_align_items = 'center';
      for (const child of (Array.isArray(el.elements) ? el.elements : [])) {
        if (!child || !child.settings || typeof child.settings !== 'object') continue;
        const cs = child.settings;
        if (child.elType === 'container') {
          // Mobile default is width:100% — keep the desktop share explicitly.
          const wm = cs.width_mobile;
          if (wm && typeof wm === 'object' && Number(wm.size) >= 100) delete cs.width_mobile;
          const w = cs.width;
          if (w && typeof w === 'object' && (!w.unit || w.unit === '%') &&
              Number(w.size) > 0 && cs.width_mobile == null) {
            cs.width_mobile = { unit: '%', size: Number(w.size), sizes: [] };
          }
        } else if (child.elType === 'widget') {
          // Widgets default to full width in containers — full-width flex items
          // each take their own line once Elementor's mobile wrap kicks in.
          // Inline (auto) keeps logo | hamburger | CTA side by side.
          if (cs._element_width == null || cs._element_width === '') cs._element_width = 'auto';
          // The header CTA stays VISIBLE on phones — never hidden.
          if (child.widgetType === 'button' && cs.hide_mobile) delete cs.hide_mobile;
        }
      }
    }
  };
  const directlyHasNav = (el) => (Array.isArray(el.elements) ? el.elements : [])
    .some((c) => c && c.elType === 'widget' && c.widgetType === 'nav-menu');

  const processBand = (root) => {
    if (!root || root.elType !== 'container') return;
    const hasNav = containsWidget(root, 'nav-menu');
    const rootDir = root.settings && root.settings.flex_direction;
    const stacked = rootDir == null || rootDir === 'column';
    // Utility tiers (topbar strips): in a STACKED multi-tier header, the tier
    // rows WITHOUT the nav are content-heavy strips (hours | area | phone |
    // socials) that CANNOT survive as one phone row — squeezing them breaks
    // text letter-by-letter. Industry standard: hide them on phones; the main
    // bar (logo + hamburger + CTA) carries mobile.
    // ONE-BAR MERGE: the model often splits the main header into a
    // [logo | CTA] deck plus a separate [nav] deck. Mobile can then never
    // show logo + hamburger + CTA in one row. When the nav deck holds ONLY
    // the nav-menu, merge it into the logo/CTA deck (nav sits before the
    // first button) and drop the empty deck.
    if (hasNav && stacked) {
      const kids = Array.isArray(root.elements) ? root.elements : [];
      const navRowIdx = kids.findIndex((c) => c && c.elType === 'container' && containsWidget(c, 'nav-menu'));
      if (navRowIdx !== -1) {
        const navRow = kids[navRowIdx];
        const rowWidgets = [];
        (function cw(n) {
          if (!n || typeof n !== 'object') return;
          if (n.elType === 'widget') rowWidgets.push(n);
          (n.elements || []).forEach(cw);
        })(navRow);
        if (rowWidgets.length === 1 && rowWidgets[0].widgetType === 'nav-menu') {
          // The merge target is the real main bar: it carries a BUTTON or an
          // IMAGE (logo). Text-only strips (dispatch topbars) never qualify.
          const target = kids.find((c) => c !== navRow && c && c.elType === 'container' &&
            !containsWidget(c, 'nav-menu') &&
            (containsWidget(c, 'button') || containsWidget(c, 'image')) &&
            !(c.settings && c.settings.hide_mobile));
          if (target && Array.isArray(target.elements)) {
            const btnIdx = target.elements.findIndex((c) => c && c.elType === 'widget' && c.widgetType === 'button');
            if (btnIdx >= 0) target.elements.splice(btnIdx, 0, rowWidgets[0]);
            else target.elements.push(rowWidgets[0]);
            kids.splice(navRowIdx, 1);
          }
        }
      }
      for (const child of (Array.isArray(root.elements) ? root.elements : [])) {
        if (child && child.elType === 'container' && child.settings &&
            typeof child.settings === 'object' && !containsWidget(child, 'nav-menu') &&
            // A row carrying a BUTTON or IMAGE is a logo/CTA fragment of the
            // main bar, NOT a utility strip — it must stay visible on phones
            // (hiding it once shipped a hamburger-only mobile header).
            !containsWidget(child, 'button') && !containsWidget(child, 'image')) {
          child.settings.hide_mobile = 'hidden-phone';
        }
      }
    }
    // Phone-width DECLUTTER for the WHOLE header: a phone fits logo +
    // hamburger + EXACTLY ONE button. Every other widget in the header band
    // (phone-number pills, subtitles, second CTAs, texts) hides on mobile.
    // The kept button prefers a non-phone CTA over a phone-number button.
    const isPhoneButton = (node) => {
      const st = node.settings || {};
      const txt = String(st.text || '');
      const url = String((st.link && st.link.url) || '');
      return /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/.test(txt) || url.startsWith('tel:');
    };
    const tidyHeaderMobile = (bandEl) => {
      const hiddenOnMobile = (node) => node.elType === 'container' &&
        node.settings && typeof node.settings === 'object' && !!node.settings.hide_mobile;
      const buttons = [];
      (function collect(node) {
        if (!node || typeof node !== 'object' || hiddenOnMobile(node)) return;
        if (node.elType === 'widget' && node.widgetType === 'button' &&
            node.settings && typeof node.settings === 'object') buttons.push(node);
        (node.elements || []).forEach(collect);
      })(bandEl);
      const keepButton = buttons.find((b) => !isPhoneButton(b)) || buttons[0] || null;
      let logoSeen = false;
      (function walkW(node) {
        if (!node || typeof node !== 'object' || hiddenOnMobile(node)) return;
        if (node.elType === 'widget' && node.settings && typeof node.settings === 'object') {
          const t = node.widgetType;
          if (t === 'nav-menu') { /* always kept */ }
          else if (t === 'button') {
            if (node !== keepButton && !node.settings.hide_mobile) {
              node.settings.hide_mobile = 'hidden-phone';
            }
          }
          else if (!logoSeen && (t === 'image' || t === 'heading')) {
            logoSeen = true;
            // The logo text must never wrap to multiple lines on a phone.
            if (t === 'heading' && node.settings.typography_font_size_mobile == null) {
              node.settings.typography_typography = node.settings.typography_typography || 'custom';
              node.settings.typography_font_size_mobile = { unit: 'px', size: 20, sizes: [] };
            }
          }
          else if (!node.settings.hide_mobile) node.settings.hide_mobile = 'hidden-phone';
        }
        (node.elements || []).forEach(walkW);
      })(bandEl);
    };

    (function walk(el) {
      if (!el || typeof el !== 'object') return;
      if (el.elType === 'container' && el.settings && typeof el.settings === 'object') {
        // The bar holding the nav is ALWAYS a row — a column main bar stacks
        // logo over hamburger over CTA and escapes every row protection.
        if (directlyHasNav(el) && el.settings.flex_direction !== 'row' &&
            el.settings.flex_direction !== 'row-reverse') {
          el.settings.flex_direction = 'row';
        }
        fixRow(el);
      }
      if (el.elType === 'widget' && el.widgetType === 'nav-menu' &&
          el.settings && typeof el.settings === 'object') {
        // The mobile dropdown must OVERLAY the page, not expand the header.
        if (!el.settings.full_width) el.settings.full_width = 'stretch';
      }
      (el.elements || []).forEach(walk);
    })(root);
    // Declutter runs LAST: fixRow above un-hides every button (its CTA-visible
    // guarantee) — the ONE-kept-button rule must have the final word.
    if (hasNav) tidyHeaderMobile(root);
  };

  // Header scope = the FIRST top-level band carrying a header marker. A
  // nav-menu further down the page (e.g. a footer nav) must NOT be one-row
  // forced. Explicit html_tag:"header" subtrees are honored anywhere.
  const els = Array.isArray(content) ? content : [];
  const band = els.find((el) => el && typeof el === 'object' && (
    (el.settings && typeof el.settings === 'object' && el.settings.html_tag === 'header') ||
    containsWidget(el, 'nav-menu')
  )) || null;
  if (band) processBand(band);
  // Explicit html_tag:"header" wrappers anywhere else are honored too.
  (function findTagged(elements) {
    for (const el of elements) {
      if (!el || typeof el !== 'object' || el === band) continue;
      if (el.elType === 'container' && el.settings &&
          typeof el.settings === 'object' && el.settings.html_tag === 'header') {
        processBand(el);
        continue; // whole subtree already processed
      }
      if (Array.isArray(el.elements) && el.elements.length) findTagged(el.elements);
    }
  })(els);
}

/**
 * ------------------------------------------------------------
 * Duplicate TOPBAR strips (step 3.63): the model sometimes emits the same
 * utility strip twice ("WE DISPATCH AS EARLY AS 6AM…" appearing as two
 * stacked bars). Strips carry no nav, so header dedupe misses them — compare
 * NORMALIZED TEXT of small nav-less, H1-less bands near the top (top-level
 * AND directly inside the first header wrapper) and remove exact repeats.
 * ------------------------------------------------------------
 */
function dedupeTopbarStrips(content, repairs) {
  const els = Array.isArray(content) ? content : [];
  const textOf = (el) => {
    let t = '';
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      const s = node.settings;
      if (s && typeof s === 'object') {
        for (const k of ['title', 'editor', 'text']) {
          if (typeof s[k] === 'string') t += ' ' + s[k];
        }
      }
      (node.elements || []).forEach(walk);
    })(el);
    return t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]/g, '');
  };
  const hasH1 = (el) => {
    let f = false;
    (function walk(n) {
      if (f || !n || typeof n !== 'object') return;
      if (n.widgetType === 'heading' && n.settings && String(n.settings.header_size || '') === 'h1') { f = true; return; }
      (n.elements || []).forEach(walk);
    })(el);
    return f;
  };
  const widgetCount = (el) => {
    let c = 0;
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.elType === 'widget') c++;
      (n.elements || []).forEach(walk);
    })(el);
    return c;
  };

  // Candidate pools: first 4 top-level bands + first 4 children of the first
  // header wrapper (marker: html_tag header or contains nav-menu).
  const pools = [];
  els.slice(0, 4).forEach((el, i) => pools.push({ arr: els, idx: i, el }));
  const headerBand = els.find((el) => el && typeof el === 'object' && el.settings &&
    (el.settings.html_tag === 'header' || containsWidget(el, 'nav-menu')));
  if (headerBand && Array.isArray(headerBand.elements)) {
    headerBand.elements.slice(0, 4).forEach((el, i) =>
      pools.push({ arr: headerBand.elements, idx: i, el }));
  }

  const grams = (t) => {
    const g = new Set();
    for (let i = 0; i <= t.length - 3; i++) g.add(t.slice(i, i + 3));
    return g;
  };
  const similar = (a, b) => {
    if (a.includes(b) || b.includes(a)) return true;
    const ga = grams(a); const gb = grams(b);
    let hit = 0;
    for (const g of ga) if (gb.has(g)) hit++;
    return (2 * hit) / (ga.size + gb.size) >= 0.8;
  };
  const seen = [];
  const toRemove = [];
  for (const cand of pools) {
    const el = cand.el;
    if (!el || el.elType !== 'container') continue;
    if (hasH1(el) || containsWidget(el, 'nav-menu') || widgetCount(el) > 6) continue;
    const t = textOf(el);
    if (t.length < 20) continue;
    if (seen.some((prev) => similar(prev, t))) toRemove.push(cand);
    else seen.push(t);
  }
  // Remove from each parent array, highest index first.
  toRemove.sort((a, b) => b.idx - a.idx);
  for (const cand of toRemove) {
    const at = cand.arr.indexOf(cand.el);
    if (at !== -1) cand.arr.splice(at, 1);
  }
  if (toRemove.length) {
    repairs.push(`Removed ${toRemove.length} duplicated topbar strip(s).`);
  }
  return toRemove.length;
}

/**
 * ------------------------------------------------------------
 * ONE header per page (step 3.64): among top-level bands that contain a
 * nav-menu widget, only the FIRST survives. A later nav-carrying band in the
 * top half of the page is a duplicated header — removed entirely. A nav in
 * the final band (a footer) keeps the band and only loses the nav widget.
 * ------------------------------------------------------------
 */
function dedupeHeaderBands(content, repairs) {
  const els = Array.isArray(content) ? content : [];
  const navBands = [];
  els.forEach((el, idx) => {
    if (el && typeof el === 'object' && containsWidget(el, 'nav-menu')) navBands.push(idx);
  });
  if (navBands.length <= 1) return 0;
  const keep = navBands[0];
  const removeWhole = new Set();
  let navStripped = 0;
  for (const idx of navBands.slice(1)) {
    if (idx <= Math.max(3, keep + 2) && idx < els.length - 1) {
      removeWhole.add(idx);
    } else {
      // Footer-ish band: strip just the nav widget(s).
      (function strip(el) {
        if (!el || !Array.isArray(el.elements)) return;
        const before = el.elements.length;
        el.elements = el.elements.filter((c) => !(c && c.elType === 'widget' && c.widgetType === 'nav-menu'));
        navStripped += before - el.elements.length;
        el.elements.forEach(strip);
      })(els[idx]);
    }
  }
  if (removeWhole.size) {
    for (let i = els.length - 1; i >= 0; i--) {
      if (removeWhole.has(i)) els.splice(i, 1);
    }
    repairs.push(`Removed ${removeWhole.size} duplicated header band(s) — a page has ONE header and ONE nav.`);
  }
  if (navStripped) {
    repairs.push(`Removed ${navStripped} extra nav-menu widget(s) — one nav per page.`);
  }
  return removeWhole.size + navStripped;
}

/**
 * ------------------------------------------------------------
 * Testimonial sliders are BANNED (step 3.62). Convert every
 * testimonial-carousel / reviews widget into a ROW container of static
 * `testimonial` widgets — same quotes, names, roles, avatars; no slider
 * scripts (they render unreliably). The widget-row normalizer afterwards
 * gives the row equal column widths.
 * ------------------------------------------------------------
 */
function convertTestimonialSliders(content, repairs) {
  let converted = 0;
  (function walk(els) {
    for (let i = 0; i < (els || []).length; i++) {
      const el = els[i];
      if (!el || typeof el !== 'object') continue;
      if (el.elType === 'widget' &&
          (el.widgetType === 'testimonial-carousel' || el.widgetType === 'reviews')) {
        const slides = Array.isArray(el.settings && el.settings.slides) ? el.settings.slides : [];
        const quotes = slides.filter((s) => s && typeof s.content === 'string' && s.content.trim());
        if (quotes.length) {
          els[i] = {
            id: el.id || shortId(),
            elType: 'container',
            isInner: true,
            settings: {
              flex_direction: 'row',
              flex_gap: { column: '24', row: '24', isLinked: true, unit: 'px' },
              flex_align_items: 'stretch',
            },
            elements: quotes.slice(0, 4).map((s) => ({
              id: shortId(),
              elType: 'widget',
              widgetType: 'testimonial',
              settings: {
                testimonial_content: s.content,
                testimonial_name: s.name || '',
                testimonial_job: s.title || '',
                ...(s.image && typeof s.image === 'object' && s.image.url
                  ? { testimonial_image: { url: s.image.url, id: s.image.id || '' } }
                  : {}),
              },
              elements: [],
            })),
          };
          converted++;
        }
      }
      if (el && Array.isArray(el.elements)) walk(el.elements);
    }
  })(Array.isArray(content) ? content : []);
  if (converted) {
    repairs.push(`Converted ${converted} testimonial slider(s) into static testimonial widgets (sliders are never used).`);
  }
  return converted;
}

/**
 * ------------------------------------------------------------
 * Hover polish (step 3.68) — deterministic, pure-CSS interactions the model
 * keeps omitting. Injected ONLY where nothing was authored:
 *   - buttons: background darkens ~12% on hover, 0.2s transition
 *   - card containers (2+ siblings in a row, with a surface or radius):
 *     lifted hover shadow, 0.3s transition
 * Never inside the header band; never on containers holding a form.
 * ------------------------------------------------------------
 */
function darkenHex(hex, factor) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const f = (v) => Math.max(0, Math.round(v * (1 - factor)));
  const r = f((n >> 16) & 255); const g = f((n >> 8) & 255); const b = f(n & 255);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/**
 * Remove every entrance/scroll animation key (step 3.67). Elementor marks
 * animated elements `elementor-invisible` and reveals them via a scroll JS
 * trigger; deferred/minified JS on cached hosts breaks the trigger and the
 * section never appears. Hover keys (pure CSS) are untouched.
 */
function stripEntranceAnimations(content, repairs) {
  const KEYS = [
    'animation', 'animation_tablet', 'animation_mobile',
    'animation_duration', 'animation_delay',
    '_animation', '_animation_tablet', '_animation_mobile',
    '_animation_delay',
  ];
  let removed = 0;
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      const s = el.settings;
      if (s && typeof s === 'object') {
        for (const k of KEYS) {
          if (s[k] != null && s[k] !== '') { delete s[k]; removed++; }
          else if (k in s) delete s[k];
        }
      }
      if (Array.isArray(el.elements)) walk(el.elements);
    }
  })(Array.isArray(content) ? content : []);
  if (removed) {
    pushOnce(repairs, 'Removed entrance/scroll animations (they hide sections on cached hosts) — hover polish carries the interactions.');
  }
  return removed;
}

/**
 * ------------------------------------------------------------
 * Usability floor (step 3.69) — deterministic minimums mined from real
 * refine history:
 *  - nav-menu: complete mobile dropdown config (dropdown breakpoint, burger
 *    toggle, toggle color, opaque dropdown panel with readable item colors),
 *    and the widget itself is never hidden on phones.
 *  - carousels: explicit arrows/dots colors (defaults are near-invisible).
 *  - text-editor: font size floor 13px, and a 1.6em line-height wherever a
 *    custom size was set without one.
 */
function enforceUsabilityFloor(content, repairs) {
  let navFixed = 0, carouselFixed = 0, textFixed = 0;
  (function walk(els) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      const s = (el.settings && typeof el.settings === 'object') ? el.settings : null;
      if (el.elType === 'widget' && s) {
        if (el.widgetType === 'nav-menu') {
          let touched = false;
          if (!s.dropdown) { s.dropdown = 'tablet'; touched = true; }
          if (!s.toggle) { s.toggle = 'burger'; touched = true; }
          if (!s.toggle_color) { s.toggle_color = s.color_menu_item || '#1a1a1a'; touched = true; }
          if (!s.dropdown_background_color) { s.dropdown_background_color = '#ffffff'; touched = true; }
          if (!s.color_dropdown_item) { s.color_dropdown_item = '#1a1a1a'; touched = true; }
          if (s.hide_mobile) { delete s.hide_mobile; touched = true; }
          if (touched) navFixed++;
        }
        if (/carousel|^slides$/.test(el.widgetType || '')) {
          let touched = false;
          if (!s.arrows_color) { s.arrows_color = '#333333'; touched = true; }
          if (!s.dots_color) { s.dots_color = '#333333'; touched = true; }
          if (touched) carouselFixed++;
        }
        if (el.widgetType === 'text-editor') {
          const fs = s.typography_font_size;
          if (fs && typeof fs === 'object' && typeof fs.size === 'number') {
            let touched = false;
            if ((fs.unit === 'px' || !fs.unit) && fs.size > 0 && fs.size < 13) {
              fs.size = 13; touched = true;
            }
            if (!s.typography_line_height) {
              s.typography_line_height = { unit: 'em', size: 1.6, sizes: [] };
              touched = true;
            }
            if (touched) textFixed++;
          }
        }
      }
      walk(el.elements);
    }
  })(content);
  if (navFixed) repairs.push(`Completed the mobile burger-menu config on ${navFixed} nav-menu widget(s).`);
  if (carouselFixed) repairs.push(`Made carousel arrows/dots visible on ${carouselFixed} widget(s).`);
  if (textFixed) repairs.push(`Raised illegibly small body text / added line-height on ${textFixed} text block(s).`);
}

function injectHoverPolish(content, repairs) {
  let touched = 0;
  (function walk(els, inHeader) {
    for (const el of els || []) {
      if (!el || typeof el !== 'object') continue;
      const s = el.settings && typeof el.settings === 'object' ? el.settings : null;
      const isHeader = inHeader || (s && s.html_tag === 'header') ||
        (el.elType === 'widget' && el.widgetType === 'nav-menu');
      if (!isHeader && el.elType === 'widget' && el.widgetType === 'button' && s) {
        if (s.background_color && !s.button_background_hover_color) {
          const darker = darkenHex(s.background_color, 0.12);
          if (darker) {
            s.button_background_hover_background = 'classic';
            s.button_background_hover_color = darker;
            if (s.button_hover_transition_duration == null) {
              s.button_hover_transition_duration = { unit: 'px', size: 0.2, sizes: [] };
            }
            touched++;
          }
        }
      }
      if (!isHeader && el.elType === 'container' && s && Array.isArray(el.elements)) {
        const containerKids = el.elements.filter((c) => c && c.elType === 'container');
        if (containerKids.length >= 2) {
          for (const card of containerKids) {
            const cs = card.settings;
            if (!cs || typeof cs !== 'object') continue;
            const isCard = cs.background_color || cs.border_radius || cs.box_shadow_box_shadow_type;
            const holdsForm = containsWidget(card, 'form');
            if (isCard && !holdsForm && !cs.box_shadow_hover_box_shadow_type) {
              cs.box_shadow_hover_box_shadow_type = 'yes';
              cs.box_shadow_hover_box_shadow = {
                horizontal: 0, vertical: 10, blur: 24, spread: 0, color: 'rgba(0,0,0,0.12)',
              };
              if (cs.border_hover_transition == null) {
                cs.border_hover_transition = { unit: 'px', size: 0.3, sizes: [] };
              }
              touched++;
            }
          }
        }
      }
      if (Array.isArray(el.elements)) walk(el.elements, isHeader);
    }
  })(Array.isArray(content) ? content : [], false);
  if (touched) {
    pushOnce(repairs, 'Hover polish added (button darken + card lift shadows) where none was set.');
  }
  return touched;
}

/** Apply normalizeRowContainer to every container in the tree; ONE note per page. */
function normalizeRowContainers(content, repairs) {
  let normalized = 0;
  (function walk(elements, insideHeader) {
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      const inHeader = insideHeader ||
        (el.settings && typeof el.settings === 'object' && el.settings.html_tag === 'header');
      // Never restructure anything inside a header band — it stays one row on all devices.
      if (el.elType === 'container' && !inHeader) normalized += normalizeRowContainer(el, repairs);
      if (Array.isArray(el.elements) && el.elements.length) walk(el.elements, inHeader);
    }
  })(Array.isArray(content) ? content : [], false);
  if (normalized > 0) {
    repairs.push(`Normalized ${normalized} row container(s) for desktop (wrap moved to mobile, widths fitted).`);
  }
  return normalized;
}

/**
 * ------------------------------------------------------------
 * Menu-anchor cleanup.
 *
 * Collect every '#anchor' referenced by any link url in any widget settings
 * (settings.link.url, nested link objects, icon_list items, …), then remove
 * every menu-anchor widget whose anchor is NOT referenced, plus duplicate
 * menu-anchors for the same anchor (the first one in document order wins).
 * One repair note with the removal count.
 * ------------------------------------------------------------
 */
function cleanupMenuAnchors(content, repairs) {
  // Owner's rule: menu-anchor widgets are NEVER used — the nav is a real
  // WordPress menu (or none), so generated anchors are dead weight the user
  // keeps finding in the Elementor tree. Remove every single one.
  let removed = 0;
  (function prune(parent) {
    for (const el of parent) {
      if (el && Array.isArray(el.elements) && el.elements.length) {
        el.elements = el.elements.filter((child) => {
          if (child && child.elType === 'widget' && child.widgetType === 'menu-anchor') {
            removed++;
            return false;
          }
          return true;
        });
        prune(el.elements);
      }
    }
  })(Array.isArray(content) ? content : []);

  if (removed > 0) {
    repairs.push(`Removed ${removed} menu-anchor widget(s) — menu anchors are never used.`);
  }
  return removed;
}

/**
 * ------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------
 */
function isElement(x) {
  return x && typeof x === 'object' && typeof x.elType === 'string';
}

/** Push a repair note only once per page (repairs is per-validate call). */
function pushOnce(repairs, note) {
  if (!repairs.includes(note)) repairs.push(note);
}

function wrapInColumn(child, usedIds, repairs, whitelist) {
  const normChild = normalizeElement(child, usedIds, repairs, 'child', whitelist);
  return {
    id: ensureUniqueId(null, usedIds),
    elType: 'column',
    isInner: false,
    settings: { _column_size: 100, _inline_size: null },
    elements: normChild ? [normChild] : [],
  };
}

function ensureUniqueId(id, usedIds) {
  let candidate = typeof id === 'string' && /^[a-z0-9]{7}$/.test(id) ? id : shortId();
  while (usedIds.has(candidate)) candidate = shortId();
  usedIds.add(candidate);
  return candidate;
}

function shortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 7; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function normalizeImage(img) {
  if (typeof img === 'string') {
    return { url: img, id: '', alt: '', source: 'library' };
  }
  if (img && typeof img === 'object') {
    return {
      url: typeof img.url === 'string' ? img.url : '',
      id: img.id != null ? img.id : '',
      alt: typeof img.alt === 'string' ? img.alt : '',
      size: img.size || '',
      source: img.source || 'library',
    };
  }
  return { url: '', id: '', alt: '', source: 'library' };
}

function normalizeGalleryItem(item) {
  if (typeof item === 'string') return { id: '', url: item };
  if (item && typeof item === 'object' && item.url) {
    return { id: item.id != null ? item.id : '', url: item.url };
  }
  return null;
}

function stripFences(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/^\uFEFF/, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function sliceOuterObject(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

/**
 * Best-effort local repair without a model call. Handles the two failure modes
 * we actually see: (1) trailing commas before } or ], and (2) a truncated tail
 * that leaves strings/brackets unclosed. Returns a parseable string or null.
 */
function tryLocalRepair(text) {
  const base = sliceFromFirstBrace(text);
  if (!base) return null;

  // 1) Trailing commas: {"a":1,} or [1,2,]  ->  {"a":1} / [1,2]
  const noTrailingCommas = stripTrailingCommas(base);
  if (isParseable(noTrailingCommas)) return noTrailingCommas;

  // 2) Truncated tail: close any open strings/brackets, then re-strip commas.
  const balanced = stripTrailingCommas(balanceBrackets(noTrailingCommas));
  if (isParseable(balanced)) return balanced;

  return null;
}

/**
 * Remove ONLY structural trailing commas (a comma that, ignoring whitespace, is
 * immediately followed by } or ]) — never a comma inside a string value. Reuses
 * the same in-string/escape tracking as balanceBrackets, so CSS/prose containing
 * ",]" or ",}" (e.g. custom_css or text-editor content) is left untouched.
 */
function stripTrailingCommas(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) continue; // drop structural trailing comma
    }
    out += ch;
  }
  return out;
}

function isParseable(s) {
  try { JSON.parse(s); return true; } catch (_) { return false; }
}

/**
 * Lenient, model-free JSON parse used by callers that receive a bare JSON
 * OBJECT (e.g. a single refined element) rather than a page. Applies the same
 * local repair ladder as parseWithRepair (fences -> outer slice -> lenient
 * repair) but never calls the model. Returns the parsed value or null.
 */
function lenientParseJson(rawText) {
  const candidate = stripFences(rawText);
  try { return JSON.parse(candidate); } catch (_) { /* keep trying */ }
  const sliced = sliceOuterObject(candidate);
  if (sliced) {
    try { return JSON.parse(sliced); } catch (_) { /* keep trying */ }
  }
  const local = tryLocalRepair(candidate);
  if (local) {
    try { return JSON.parse(local); } catch (_) { /* give up */ }
  }
  return null;
}

function sliceFromFirstBrace(text) {
  const first = text.indexOf('{');
  return first === -1 ? null : text.slice(first);
}

/**
 * Walk the text tracking string/escape state and the bracket stack, then append
 * the closers needed to balance it. Salvages JSON cut off mid-generation.
 */
function balanceBrackets(text) {
  const stack = [];
  let inStr = false;
  let esc = false;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += ch;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}') { if (stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack[stack.length - 1] === '[') stack.pop(); }
  }
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

function sanitizeCss(css, repairs) {
  if (typeof css !== 'string' || !css.trim()) return '';
  let out = css
    .replace(/<\/style/gi, '')
    .replace(/<script/gi, '')
    .replace(/<\/script/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/@import/gi, '')
    .replace(/javascript:/gi, '');
  if (Buffer.byteLength(out, 'utf8') > MAX_CSS_BYTES) {
    out = out.slice(0, MAX_CSS_BYTES);
    repairs.push('custom_css exceeded 50 KB and was truncated.');
  }
  return out;
}

module.exports = {
  validateAndRepair,
  containerizePage,
  normalizeRowContainer,
  enforceHeaderRows,
  enforceUsabilityFloor,
  dedupeHeaderBands,
  dedupeTopbarStrips,
  cleanupMenuAnchors,
  lenientParseJson,
  FREE_WIDGET_WHITELIST,
  PRO_WIDGET_WHITELIST,
  WIDGET_WHITELIST,
  shortId,
};
