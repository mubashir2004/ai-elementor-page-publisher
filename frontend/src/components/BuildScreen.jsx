/**
 * ============================================================
 * FILE: frontend/src/components/BuildScreen.jsx
 * OWNER: Person 9 (build UI + progress + result)
 *        Person 7 (image dropzone)
 *        Person 8 (edit-mode dropdown + refine box)
 *
 * Prompt + images + mode + template → streamed generation →
 * result card (View / Edit in Elementor / Refine / Download),
 * plus: version history (preview/restore), pro-widget report,
 * Elementor-globals colors/fonts toggle, multi-page site runs,
 * and design variations (A/B/C).
 * ============================================================
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  listPages, streamRun, fileToOptimizedBase64, pdfToImages, getBrandKits,
  getStarterBriefs, previewPage, getHistory, getHistoryVersion, restoreVersion, copySection,
  getGlobals, listComponents, saveComponent, deleteComponent,
  listBrands, saveBrand, deleteBrand, updateBrand, scanWebsite, republishPage, getSuggestions,
  suggestComponents, getProUsage, getGlobalWidgets, createGlobalWidget,
} from '../api';

const STAGES = [
  ['analyzing', 'Analyzing design'],
  ['generating', 'Generating page'],
  ['validating', 'Validating'],
  ['refining', 'Polishing'],
  ['images', 'Fetching images'],
  ['publishing', 'Publishing'],
];

/** Stage progress pills — shared by the generate and refine flows.
 *  `detail` is a short live string (e.g. '38,400 chars written') shown as a
 *  muted line under the ACTIVE step while it streams in.
 *  `withRefine` adds the Auto-refine "Refining" step (shown only when the
 *  checkbox is on, or the backend reports that stage). */
function Stepper({ stage, detail, withRefine }) {
  const steps = (withRefine || stage === 'autorefine')
    ? STAGES.flatMap((s) => (s[0] === 'refining' ? [s, ['autorefine', 'Refining']] : [s]))
    : STAGES;
  const activeIdx = steps.findIndex(([k]) => k === stage);
  return (
    <div className="stepper">
      {steps.map(([key, label], myIdx) => {
        const state = stage == null ? 'pending'
          : myIdx < activeIdx ? 'done'
          : myIdx === activeIdx ? 'active' : 'pending';
        const showDetail = state === 'active' && detail;
        return (
          <div key={key} className={`step ${state}`}>
            <span className="step-dot" />
            {showDetail ? (
              <span className="step-text">
                {label}
                <span className="step-detail">{detail}</span>
              </span>
            ) : label}
          </div>
        );
      })}
    </div>
  );
}

/* ---- Section labeling for section-level refine ---- */

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Depth-first search for the first heading widget's title in an element tree. */
function findFirstHeading(el) {
  if (!el || typeof el !== 'object') return null;
  if (el.elType === 'widget' && el.widgetType === 'heading') {
    const t = el.settings && el.settings.title;
    if (t) {
      const text = stripTags(t);
      if (text) return text;
    }
  }
  for (const child of el.elements || []) {
    const found = findFirstHeading(child);
    if (found) return found;
  }
  return null;
}

/** Depth-first search for the first widget type in an element tree. */
function findFirstWidgetType(el) {
  if (!el || typeof el !== 'object') return null;
  if (el.elType === 'widget' && el.widgetType) return el.widgetType;
  for (const child of el.elements || []) {
    const found = findFirstWidgetType(child);
    if (found) return found;
  }
  return null;
}

function sectionLabel(el) {
  const label = findFirstHeading(el) || findFirstWidgetType(el) || el.elType || 'element';
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

/* ---- Preview device presets ---- */

const DEVICES = [
  ['desktop', 'Desktop', 1360],
  ['tablet', 'Tablet', 768],
  ['mobile', 'Mobile', 390],
];

const EXAMPLES = [
  'A dark, editorial architecture studio landing page with hero, projects, services, team and contact.',
  'A friendly local dental clinic: hero, services, meet the dentists, reviews, book-a-visit contact.',
  'A modern SaaS product page for an invoicing tool: hero, features, pricing tiers, FAQ, sign-up CTA.',
];

// "Unlimited" in practice is bounded by the Claude API's ~32 MB request
// ceiling — 30 auto-optimized references is the safe maximum that fits.
const MAX_IMAGES = 30;
// No per-file size cap: any reference image (30 MB, 100 MB, ...) is
// auto-downscaled in the browser to an API-safe size (fileToOptimizedBase64).
// PDFs are rasterized page by page, capped at 30 pages.
const MAX_PDF_PAGES = 30;
// Tiered per-image budgets: past 3 references shrink each image; past 10,
// shrink harder so even a 30-reference batch stays under the request ceiling.
const MANY_IMAGES_THRESHOLD = 3;
const SMALL_TARGET_BYTES = 1.5 * 1024 * 1024;
const SMALL_MAX_EDGE = 1600;
const LOTS_IMAGES_THRESHOLD = 10;
const TINY_TARGET_BYTES = 0.7 * 1024 * 1024;
const TINY_MAX_EDGE = 1280;

/* ---- Multi-page + variations helpers ---- */

/** Per-page suffix appended to the user brief on multi-page runs. */
function multiPagePrompt(userPrompt, name) {
  return `${userPrompt}\n\nThis is the "${name}" page of a multi-page site. Build THIS page only. Keep the palette, typography, header and footer IDENTICAL across all pages of the site so they read as one brand.`;
}

/** Distinct art-direction directives for the design-variations run. */
const VARIATION_DIRECTIVES = [
  ['Variation A', '\n\nVariation A: follow the reference/brief most literally.'],
  ['Variation B', '\n\nVariation B: EXACTLY the same sections, layout, structure, alignment and order as the reference/brief. Vary ONLY the styling mood, bolder: heavier heading weights, larger type-scale contrast, stronger accent usage (accent-filled buttons, accent eyebrows/dividers), darker band alternation, deeper shadows. NEVER change section structure, column layouts, or the spacing rhythm; every alignment and mobile rule still applies.'],
  ['Variation C', '\n\nVariation C: EXACTLY the same sections, layout, structure, alignment and order as the reference/brief. Vary ONLY the styling mood, lighter: whitespace-forward (upper end of the allowed padding scale), softer shadows, lighter band alternation, outline/ghost secondary buttons, quieter accent usage. NEVER change section structure, column layouts, or the spacing rhythm; every alignment and mobile rule still applies.'],
];

/** Component-library section types. */
const COMPONENT_TYPES = ['hero', 'services', 'about', 'stats', 'testimonials', 'cta', 'footer', 'other'];

/** Fallback document when the preview endpoint returns no html. */
const NO_PREVIEW_HTML = '<p style="font-family:sans-serif;padding:24px">No preview available.</p>';

/** Empty per-side state for the compare modal. */
const COMPARE_SIDE_EMPTY = { busy: false, html: null, error: null };

/** Human date/time for a history timestamp (ISO string or epoch s/ms). */
function formatTs(ts) {
  if (ts == null || ts === '') return '';
  const d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** One-line verdict for the aggregated Pro-usage report. */
function proUsageVerdict(usage) {
  const runs = Number(usage && usage.runs) || 0;
  const widgets = (usage && usage.widgets) || [];
  if (runs >= 4 && widgets.some((w) => (Number(w.runs) || 0) >= runs * 0.5)) {
    return 'Pro widgets are pulling their weight on this site.';
  }
  if (runs >= 4 && widgets.length > 0 && widgets.every((w) => (Number(w.runs) || 0) < runs * 0.25)) {
    return 'Light Pro usage so far — free alternatives may be enough.';
  }
  return 'Not enough runs yet to judge.';
}

/** Page label for edit-mode selects — flags pages that will be migrated. */
function pageOptionLabel(p) {
  return p && p.built_with_elementor === false
    ? `${p.title} (not Elementor — will be migrated)`
    : (p && p.title) || '';
}

/** Immutably patch one item of a batch state object. */
function patchBatchItem(batch, index, patch) {
  if (!batch) return batch;
  return {
    ...batch,
    items: batch.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
  };
}

export default function BuildScreen({
  elementorPro = false,
  allowPro = false,
  setAllowPro = () => {},
  unsplashKey = '',
  geminiKey = '',
  brandContext = '',
}) {
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState([]);      // [{ base64, mediaType, name, preview }]
  const [mode, setMode] = useState('new');       // 'new' | 'edit'
  const [pages, setPages] = useState([]);
  const [pageId, setPageId] = useState('');
  const [template, setTemplate] = useState('canvas');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('draft');

  const [brandKits, setBrandKits] = useState([]);
  const [brandKitId, setBrandKitId] = useState('');   // '' = None
  const [autoRefine, setAutoRefine] = useState(false);

  const [briefs, setBriefs] = useState([]);
  const [imageMode, setImageMode] = useState('auto'); // 'auto' | 'unsplash' | 'gemini'
  const [brandOpen, setBrandOpen] = useState(false);
  const [brand, setBrand] = useState({
    businessIdentity: '', audience: '', voice: '',
    contentSeoRules: '', technicalConstraints: '', doNot: '',
  });

  // Colors & fonts source: fresh palette vs the site's Elementor globals.
  const [colorSource, setColorSource] = useState('new'); // 'new' | 'globals'
  const [globals, setGlobals] = useState(null);          // /api/globals payload when available
  const [globalsLoading, setGlobalsLoading] = useState(false);
  const [globalsNotice, setGlobalsNotice] = useState('');

  // Multi-page site + design variations (mutually exclusive).
  const [multiPage, setMultiPage] = useState(false);
  // Each page of a multi-page site carries its OWN references (uploads and/or
  // a scanned URL); a page without any falls back to the shared references.
  const newSitePage = (name = '') => ({
    id: Math.random().toString(36).slice(2, 9), name, images: [], scanUrl: '', scanBusy: false, scanError: '',
  });
  const [sitePages, setSitePages] = useState(() => [newSitePage(''), newSitePage('')]);
  const patchSitePage = (id, patch) => setSitePages((cur) => cur.map((pg) => (
    pg.id === id ? { ...pg, ...(typeof patch === 'function' ? patch(pg) : patch) } : pg
  )));
  const [variations, setVariations] = useState(1); // 1 | 2 | 3

  // Header handling: most WP themes already provide one, so default 'none'.
  const [includeHeader, setIncludeHeader] = useState('none'); // 'none' | 'temporary' | 'full'

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(null);
  const [stageDetail, setStageDetail] = useState(''); // live sub-stage detail ('38,400 chars written')
  const [result, setResult] = useState(null);   // single-run result
  const [error, setError] = useState(null);

  // Batch results (multi-page or variations run).
  // { kind: 'multi'|'variations', items: [{ name, body, status, result, error }] }
  const [batch, setBatch] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0); // 'active result' within a batch
  const [batchProgress, setBatchProgress] = useState(null); // { index, total, name }

  const [refineOpen, setRefineOpen] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState('');
  const [refineTarget, setRefineTarget] = useState(''); // '' = whole page, else top-level element id

  // Version history panel.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersions, setHistoryVersions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [versionBusy, setVersionBusy] = useState(null); // 'p:<id>' | 'r:<id>' | null
  const [restoredNotice, setRestoredNotice] = useState(false);

  const [previewHtml, setPreviewHtml] = useState(null); // string | null (modal open when set)
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewDevice, setPreviewDevice] = useState('desktop'); // 'desktop' | 'tablet' | 'mobile'
  const [previewScale, setPreviewScale] = useState(1);
  const [previewInteractive, setPreviewInteractive] = useState(false); // click-to-select enabled
  const [previewDeviceBusy, setPreviewDeviceBusy] = useState(false);   // device re-render in flight
  const [previewError, setPreviewError] = useState(null);              // device re-render failure

  // Component library (saved sections, reusable across pages).
  const [components, setComponents] = useState([]);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const [componentsLoading, setComponentsLoading] = useState(false);
  const [componentsError, setComponentsError] = useState(null);
  const [libBusy, setLibBusy] = useState(false); // a delete is in flight
  const [selectedComponentIds, setSelectedComponentIds] = useState([]); // sent as componentIds
  const [saveCompFor, setSaveCompFor] = useState(null); // section id with the save mini-form open
  const [saveCompName, setSaveCompName] = useState('');
  const [saveCompType, setSaveCompType] = useState('other');
  const [saveCompBusy, setSaveCompBusy] = useState(false);
  const [saveCompError, setSaveCompError] = useState(null);
  const [compSavedNotice, setCompSavedNotice] = useState(false);

  // AI component suggestions ("which saved blocks fit this brief?").
  const [compPicks, setCompPicks] = useState({});           // id -> reason
  const [compSuggestBusy, setCompSuggestBusy] = useState(false);
  const [compSuggestError, setCompSuggestError] = useState(null);
  const [compSuggestEmpty, setCompSuggestEmpty] = useState(false);

  // Cross-run Pro-widget usage history.
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState(null);
  const [proUsage, setProUsage] = useState(null);

  // Site global widgets (Elementor Pro; auto-sync everywhere they're used).
  const [gwOpen, setGwOpen] = useState(false);
  const [gwBusy, setGwBusy] = useState(false);
  const [gwError, setGwError] = useState(null);
  const [gw, setGw] = useState(null);                       // {available, widgets, message}
  const [useGW, setUseGW] = useState(false);
  const [gwCreateBusyId, setGwCreateBusyId] = useState(null);
  const [gwNotice, setGwNotice] = useState('');

  // Saved brands (My brands).
  const [myBrands, setMyBrands] = useState([]);
  const [myBrandId, setMyBrandId] = useState(''); // '' = none; sent as brandId
  const [brandManageOpen, setBrandManageOpen] = useState(false);
  const [brandSaveOpen, setBrandSaveOpen] = useState(false);
  const [brandSaveName, setBrandSaveName] = useState('');
  const [brandSaveBusy, setBrandSaveBusy] = useState(false);
  const [brandBusy, setBrandBusy] = useState(false); // a delete is in flight
  const [brandError, setBrandError] = useState(null);
  const [brandHint, setBrandHint] = useState(''); // mutual-exclusion hint (globals ↔ saved brand)

  // Bulk redesign (edit mode: one instruction applied to several pages).
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkPageIds, setBulkPageIds] = useState([]); // page ids as strings

  // Scan a website for reference images + design hints.
  const [scanUrl, setScanUrl] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState(null);

  // Section reorder: a LOCAL copy of rawJson.content until republished.
  const [orderedContent, setOrderedContent] = useState(null); // null = untouched
  const [orderDirty, setOrderDirty] = useState(false);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderError, setOrderError] = useState(null);

  // AI suggestions.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestions, setSuggestions] = useState(null); // null = not fetched yet
  const [suggestError, setSuggestError] = useState(null);

  // Undo / redo (stacks of versionIds, backed by version history).
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [undoRedoBusy, setUndoRedoBusy] = useState(null); // 'undo' | 'redo' | null
  const [undoNotice, setUndoNotice] = useState('');

  // Click-to-select bridge (preview → section refine) notice.
  const [refineNotice, setRefineNotice] = useState('');

  // Drag-and-drop section reorder (indices into workingContent).
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // Side-by-side compare modal.
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSel, setCompareSel] = useState({ left: '', right: '' });
  const [compareSides, setCompareSides] = useState({ left: COMPARE_SIDE_EMPTY, right: COMPARE_SIDE_EMPTY });
  const [compareScale, setCompareScale] = useState(1);
  // Section transplant between compared variations.
  const [transplantSel, setTransplantSel] = useState({ left: '', right: '' });
  const [transplantBusy, setTransplantBusy] = useState(false);
  const [transplantMsg, setTransplantMsg] = useState(null); // { side, text, ok }

  // Brand edit / share.
  const [brandSaveShared, setBrandSaveShared] = useState(false); // save form: scope 'all'
  const [brandEditId, setBrandEditId] = useState(null);          // brand id with the edit form open
  const [brandEditName, setBrandEditName] = useState('');
  const [brandEditUpdateCtx, setBrandEditUpdateCtx] = useState(false);
  const [brandEditShared, setBrandEditShared] = useState(false);
  const [brandEditBusy, setBrandEditBusy] = useState(false);

  const fileInput = useRef(null);
  const previewBodyRef = useRef(null);
  // Refine panel scroll/focus targets (click-to-select + section dropdown).
  const refinePanelRef = useRef(null);
  const refineInputRef = useRef(null);
  const restoredTimer = useRef(null);
  const compSavedTimer = useRef(null);
  const refineNoticeTimer = useRef(null);
  const undoNoticeTimer = useRef(null);
  // Preview modal context: what's being previewed + a per-device html cache.
  const previewCtxRef = useRef(null); // { pageJson, interactive, cache: { desktop|tablet|mobile: html } }
  const previewOpenRef = useRef(false);
  const previewDeviceReqRef = useRef('desktop');
  const previewSelectRef = useRef(() => {}); // latest click-to-select handler
  // Compare modal plumbing.
  const compareCacheRef = useRef({});               // option key -> rendered html
  const compareReqRef = useRef({ left: 0, right: 0 }); // stale-response guards
  const comparePaneRef = useRef(null);

  // Load pages when switching to edit mode.
  useEffect(() => {
    if (mode === 'edit' && pages.length === 0) {
      listPages().then(setPages).catch((e) => setError({ message: e.message }));
    }
  }, [mode]);

  // Load brand-kit presets + starter briefs + saved brands once.
  useEffect(() => {
    getBrandKits().then(setBrandKits).catch(() => setBrandKits([]));
    getStarterBriefs().then(setBriefs).catch(() => setBriefs([]));
    listBrands().then((b) => setMyBrands(Array.isArray(b) ? b : [])).catch(() => setMyBrands([]));
  }, []);

  useEffect(() => () => {
    if (restoredTimer.current) clearTimeout(restoredTimer.current);
    if (compSavedTimer.current) clearTimeout(compSavedTimer.current);
    if (refineNoticeTimer.current) clearTimeout(refineNoticeTimer.current);
    if (undoNoticeTimer.current) clearTimeout(undoNoticeTimer.current);
  }, []);

  // Visual-editor bridge: the interactive preview iframe posts
  // {type:'eai-select-section', index} when a top-level section is clicked.
  // Added on mount, removed on unmount; the handler itself lives in a ref so
  // it always sees the current render's state.
  useEffect(() => {
    const onMessage = (e) => {
      const d = e && e.data;
      if (d && d.type === 'eai-select-section') previewSelectRef.current(d.index);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Compile the structured brand fields into a labeled block; fall back to the
  // freeform brandContext from Connect when no structured fields are filled.
  function composeBrandContext() {
    const rows = [
      ['Business identity', brand.businessIdentity],
      ['Primary audience', brand.audience],
      ['Brand & voice/tone', brand.voice],
      ['Content & SEO rules', brand.contentSeoRules],
      ['Technical constraints', brand.technicalConstraints],
      ['Do NOT', brand.doNot],
    ].filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v.trim()}`);
    return rows.length ? rows.join('\n') : (brandContext || '');
  }

  const brandTokenEstimate = Math.ceil(
    (Object.values(brand).join(' ').trim().length || 0) / 4,
  );

  /** Convert a FileList into reference image objects (PNG/JPG/PDF pages) within
   *  the MAX_IMAGES limit. Shared by the main references and per-page references
   *  in multi-page mode. Returns [] when nothing fits. */
  async function filesToImages(fileList, currentCount) {
    const files = Array.from(fileList);
    const room = MAX_IMAGES - currentCount;
    if (room <= 0) {
      setError({ message: `Limit is ${MAX_IMAGES} references — remove one first.` });
      return [];
    }
    // Tiered per-image budgets so even a 30-reference batch stays under the
    // Claude request ceiling: >3 refs = smaller, >10 refs = smallest.
    const total = currentCount + files.length;
    const budget = total > LOTS_IMAGES_THRESHOLD
      ? [TINY_TARGET_BYTES, TINY_MAX_EDGE]
      : (total > MANY_IMAGES_THRESHOLD ? [SMALL_TARGET_BYTES, SMALL_MAX_EDGE] : null);
    const next = [];
    for (const f of files) {
      if (next.length >= room) break;
      const isPdf = /^application\/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
      try {
        if (isPdf) {
          // PDFs bypass the 20 MB per-file check; pages are capped instead.
          const slots = Math.min(MAX_PDF_PAGES, room - next.length);
          const pdfPages = await pdfToImages(f, slots);
          for (const p of pdfPages) {
            next.push({ ...p, preview: `data:${p.mediaType};base64,${p.base64}` });
          }
          // LOUD truncation notice — never silently drop pages.
          if (pdfPages.totalPages && pdfPages.totalPages > pdfPages.length) {
            setError({
              message: `${f.name} has ${pdfPages.totalPages} pages — added the first ` +
                `${pdfPages.length} (reference limit is ${MAX_IMAGES}). Remove some ` +
                `references or split the PDF to include the rest.`,
            });
          }
          continue;
        }
        if (!/^image\/(png|jpe?g)$/i.test(f.type)) {
          setError({ message: `${f.name}: only PNG, JPG or PDF allowed.` });
          continue;
        }
        // No upload size cap: fileToOptimizedBase64 downscales/compresses any
        // image to an API-safe size before it is ever sent anywhere.
        const b = budget
          ? await fileToOptimizedBase64(f, budget[0], budget[1])
          : await fileToOptimizedBase64(f);
        next.push({ ...b, preview: URL.createObjectURL(f) });
      } catch (e) {
        setError({ message: `${f.name}: ${(e && e.message) || 'could not be read.'}` });
      }
    }
    return next;
  }


  async function addFiles(fileList) {
    const next = await filesToImages(fileList, images.length);
    if (next.length) setImages((cur) => [...cur, ...next].slice(0, MAX_IMAGES));
  }

  /** Multi-page: add references to ONE page only. */
  async function addPageFiles(pageId, fileList) {
    const pg = sitePages.find((x) => x.id === pageId);
    const next = await filesToImages(fileList, pg ? pg.images.length : 0);
    if (next.length) patchSitePage(pageId, (x) => ({ images: [...x.images, ...next].slice(0, MAX_IMAGES) }));
  }

  function removePageImage(pageId, i) {
    patchSitePage(pageId, (x) => ({ images: x.images.filter((_, idx) => idx !== i) }));
  }

  function removeImage(i) {
    setImages((cur) => cur.filter((_, idx) => idx !== i));
  }

  const namedSitePages = sitePages.filter((pg) => pg.name.trim());
  const parsedPageNames = namedSitePages.map((pg) => pg.name.trim());
  const unnamedCount = sitePages.length - namedSitePages.length;
  const duplicateNames = [...new Set(
    parsedPageNames.filter((n, i) => parsedPageNames.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i)
  )];
  const multiActive = mode === 'new' && multiPage;
  const variationsActive = mode === 'new' && !multiPage && variations > 1;
  const useGlobalsActive = colorSource === 'globals' && !!globals;
  const bulkActive = mode === 'edit' && bulkMode;

  const canGenerate = !running && (prompt.trim().length > 0 || images.length > 0) &&
    (mode === 'new' || (bulkActive ? bulkPageIds.length > 0 : pageId)) &&
    (!multiActive || parsedPageNames.length > 0);

  // The result the detail panels (refine / history / pro report / download)
  // operate on: the single result, or the selected item of a batch.
  const activeItem = batch ? (batch.items[activeIdx] || null) : null;
  const activeResult = batch ? (activeItem && activeItem.result) : result;

  // Top-level containers/sections of the generated page, for section-level
  // refine + save-to-library + reorder. Reordering edits a LOCAL copy
  // (orderedContent) until 'Apply new order' republishes it.
  const baseContent = (activeResult && activeResult.rawJson && Array.isArray(activeResult.rawJson.content))
    ? activeResult.rawJson.content
    : [];
  const workingContent = orderedContent || baseContent;
  const sections = workingContent
    .map((el, i) => ({ id: el && el.id, n: i + 1, label: sectionLabel(el || {}) }))
    .filter((s) => s.id);

  const activeBrand = myBrandId
    ? myBrands.find((b) => String(b.id) === String(myBrandId)) || null
    : null;

  /** Bring the refine panel into view and focus its textarea (after the
   *  50ms timeout the panel has rendered following the state updates). */
  function scrollRefineIntoView() {
    setTimeout(() => {
      refinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      refineInputRef.current?.focus({ preventScroll: true });
    }, 50);
  }

  // Kept fresh every render so the mount-once 'message' listener acts on the
  // CURRENT preview/result state (click-to-select in the interactive preview).
  previewSelectRef.current = (rawIndex) => {
    const ctx = previewCtxRef.current;
    if (!ctx || !ctx.interactive || !previewOpenRef.current) return;
    const index = Number(rawIndex);
    const content = (activeResult && activeResult.rawJson && Array.isArray(activeResult.rawJson.content))
      ? activeResult.rawJson.content
      : [];
    const el = Number.isInteger(index) ? content[index] : null;
    if (!el || !el.id) return;
    closePreview();
    setRefineTarget(el.id);
    setRefineOpen(true);
    setRefineNotice(`Section ${index + 1} — ${sectionLabel(el)} selected for refine`);
    if (refineNoticeTimer.current) clearTimeout(refineNoticeTimer.current);
    refineNoticeTimer.current = setTimeout(() => setRefineNotice(''), 6000);
    scrollRefineIntoView();
  };

  // Result-scoped panels: drop local reorder / suggestions / save-form state
  // whenever the active result changes (refine done, batch card switch, …).
  useEffect(() => {
    setOrderedContent(null);
    setOrderDirty(false);
    setOrderError(null);
    setSaveCompFor(null);
    setSaveCompError(null);
    setSuggestOpen(false);
    setSuggestions(null);
    setSuggestError(null);
    setDragIdx(null);
    setDragOverIdx(null);
  }, [activeResult]);

  function resetRun() {
    setResult(null);
    setBatch(null);
    setBatchProgress(null);
    setActiveIdx(0);
    setError(null);
    setStage(null);
    setStageDetail('');
    setRefineOpen(false);
    setRefinePrompt('');
    setRefineTarget('');
    setHistoryOpen(false);
    setHistoryVersions([]);
    setHistoryError(null);
    setVersionBusy(null);
    setRestoredNotice(false);
    setOrderedContent(null);
    setOrderDirty(false);
    setOrderError(null);
    setSaveCompFor(null);
    setSaveCompError(null);
    setSuggestOpen(false);
    setSuggestions(null);
    setSuggestError(null);
    // Undo/redo stacks and the compare modal are page-scoped — a NEW run
    // invalidates them (a new generate always clears the redo stack).
    setUndoStack([]);
    setRedoStack([]);
    setUndoRedoBusy(null);
    setUndoNotice('');
    setRefineNotice('');
    setDragIdx(null);
    setDragOverIdx(null);
    setCompareOpen(false);
    compareCacheRef.current = {};
  }

  /** Update the active result in place (after refine / restore). */
  function applyResultUpdate(r, inBatch, idx) {
    if (inBatch) setBatch((b) => patchBatchItem(b, idx, { result: r }));
    else setResult(r);
  }

  /** The common generate body — one place for options + useGlobals wiring. */
  function baseGenerateBody() {
    return {
      mode,
      pageId: mode === 'edit' ? Number(pageId) : undefined,
      prompt,
      images: images.map(({ base64, mediaType, name }) => ({ base64, mediaType, name })),
      template,
      title: title || undefined,
      status,
      allowPro,
      // Brand kit is superseded by the site's Elementor globals or a saved brand.
      brandKit: (useGlobalsActive || myBrandId) ? undefined : (brandKitId || undefined),
      brandId: myBrandId || undefined,
      brandContext: composeBrandContext() || undefined,
      autoRefine,
      imageMode,
      geminiKey,
      includeHeader,
      useGlobals: useGlobalsActive || undefined,
      useGlobalWidgets: useGW || undefined,
      componentIds: selectedComponentIds.length > 0 ? selectedComponentIds : undefined,
    };
  }

  /** streamRun as a promise that never rejects — used by the sequential batches. */
  function runStreamPromise(path, body) {
    return new Promise((resolve) => {
      streamRun(path, body, {
        onProgress: (s, d) => { setStage(s); setStageDetail(d || ''); },
        onDone: (r) => resolve({ ok: true, result: r }),
        onError: (e) => resolve({ ok: false, error: e || { message: 'Run failed.' } }),
      });
    });
  }

  /** Sequential batch run (multi-page / variations / bulk redesign). One failure never stops the rest. */
  async function runBatch(kind, items) {
    setBatch({
      kind,
      items: items.map((it) => ({ ...it, status: 'pending', result: null, error: null })),
    });
    setActiveIdx(0);
    // PARALLEL batch: all items run concurrently (each publishes its own
    // draft). Sequential runs made 3 variations take 3x a full build.
    setBatchProgress({ index: items.length, total: items.length, name: 'running in parallel' });
    let firstDone = -1;
    await Promise.all(items.map(async (item, i) => {
      setBatch((b) => patchBatchItem(b, i, { status: 'running' }));
      const out = await runStreamPromise(item.path || '/api/generate', item.body);
      if (out.ok) {
        setBatch((b) => patchBatchItem(b, i, { status: 'done', result: out.result }));
        if (firstDone === -1) { firstDone = i; setActiveIdx(i); }
      } else {
        setBatch((b) => patchBatchItem(b, i, { status: 'error', error: out.error }));
      }
    }));
    setBatchProgress(null);
    setStage(null);
    setStageDetail('');
    setRunning(false);
  }

  /** Re-run a single failed page/variation of the batch. */
  async function retryBatchItem(i, item) {
    if (running || !batch) return;
    setRunning(true);
    setError(null);
    setStage(null);
    setStageDetail('');
    setBatchProgress({ index: i + 1, total: batch.items.length, name: item.name });
    setBatch((b) => patchBatchItem(b, i, { status: 'running', error: null }));
    const out = await runStreamPromise(item.path || '/api/generate', item.body);
    if (out.ok) {
      setBatch((b) => patchBatchItem(b, i, { status: 'done', result: out.result }));
      setActiveIdx(i);
    } else {
      setBatch((b) => patchBatchItem(b, i, { status: 'error', error: out.error }));
    }
    setBatchProgress(null);
    setStage(null);
    setStageDetail('');
    setRunning(false);
  }

  async function handleGenerate() {
    resetRun();
    setRunning(true);

    // Bulk redesign: sequential refine runs, one per selected page.
    if (bulkActive && bulkPageIds.length > 0) {
      await runBatch('bulk', bulkPageIds.map((id) => {
        const p = pages.find((pg) => String(pg.id) === String(id));
        return {
          name: (p && p.title) || `Page ${id}`,
          path: '/api/refine',
          body: {
            pageId: Number(id),
            refinePrompt: prompt,
            imageMode,
            geminiKey,
            includeHeader,
            brandId: myBrandId || undefined,
          },
        };
      }));
      return;
    }

    if (multiActive && namedSitePages.length > 0) {
      // Each page uses its OWN references when it has any; otherwise the
      // shared references (so the brand still carries across the site).
      await runBatch('multi', namedSitePages.map((pg) => {
        const name = pg.name.trim();
        const page1Refs = (sitePages[0] && sitePages[0].images) || [];
        const refs = pg.images.length ? pg.images : (page1Refs.length ? page1Refs : images);
        return {
          name,
          body: {
            ...baseGenerateBody(),
            title: name,
            prompt: multiPagePrompt(prompt, name),
            images: refs.map(({ base64, mediaType, name: n }) => ({ base64, mediaType, name: n })),
          },
        };
      }));
      return;
    }

    if (variationsActive) {
      // All variations publish as drafts; the user picks a winner in WP.
      await runBatch('variations', VARIATION_DIRECTIVES.slice(0, variations).map(([name, directive]) => ({
        name,
        body: { ...baseGenerateBody(), status: 'draft', prompt: `${prompt}${directive}` },
      })));
      return;
    }

    await streamRun('/api/generate', baseGenerateBody(), {
      onProgress: (s, d) => { setStage(s); setStageDetail(d || ''); },
      onDone: (r) => { setResult(r); setRunning(false); setStage(null); setStageDetail(''); },
      onError: (e) => { setError(e); setRunning(false); setStage(null); setStageDetail(''); },
    });
  }

  /** The refine flow — used by the Refine panel and by AI-suggestion Apply. */
  async function runRefineFlow(promptText, targetId) {
    if (!activeResult || !promptText || !promptText.trim()) return;
    const inBatch = !!batch;
    const idx = activeIdx;
    setRunning(true);
    setError(null);
    setStage(null);
    setStageDetail('');
    // Section-level refine: send the top-level element id — the backend does a
    // guaranteed splice (only that section changes). Omitted = whole page.
    const target = targetId ? sections.find((s) => s.id === targetId) : null;
    const body = {
      pageId: activeResult.pageId,
      refinePrompt: promptText,
      sectionId: target ? target.id : undefined,
      previousJson: { pageId: activeResult.pageId },
      allowPro,
      brandKit: (useGlobalsActive || myBrandId) ? undefined : (brandKitId || undefined),
      brandId: myBrandId || undefined,
      brandContext: composeBrandContext() || undefined,
      autoRefine,
      imageMode,
      geminiKey,
      includeHeader,
      useGlobals: useGlobalsActive || undefined,
    };
    await streamRun('/api/refine', body, {
      onProgress: (s, d) => { setStage(s); setStageDetail(d || ''); },
      onDone: (r) => {
        applyResultUpdate(r, inBatch, idx);
        setRedoStack([]); // a NEW refine invalidates any redo trail
        setRunning(false); setStage(null); setStageDetail('');
        setRefineOpen(false); setRefinePrompt(''); setRefineTarget('');
      },
      onError: (e) => { setError(e); setRunning(false); setStage(null); setStageDetail(''); },
    });
  }

  function handleRefine() {
    return runRefineFlow(refinePrompt, refineTarget);
  }

  function downloadJson() {
    if (!activeResult || !activeResult.rawJson) return;
    const blob = new Blob([JSON.stringify(activeResult.rawJson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elementor-page-${activeResult.pageId || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Render any page JSON into the preview modal. Throws on failure.
   * interactive:true (result-page previews only) makes top-level sections
   * clickable inside the iframe — clicking one selects it for refine.
   */
  async function openPreviewForJson(pageJson, interactive = false) {
    const { html } = await previewPage(pageJson, { device: 'desktop', interactive });
    const doc = html || NO_PREVIEW_HTML;
    previewCtxRef.current = { pageJson, interactive, cache: { desktop: doc } };
    previewOpenRef.current = true;
    previewDeviceReqRef.current = 'desktop';
    setPreviewInteractive(interactive);
    setPreviewDevice('desktop');
    setPreviewError(null);
    setPreviewDeviceBusy(false);
    setPreviewHtml(doc);
  }

  function closePreview() {
    previewOpenRef.current = false;
    setPreviewHtml(null);
    setPreviewError(null);
    setPreviewDeviceBusy(false);
  }

  /**
   * Device toggle: serve the cached render for that device instantly, else
   * re-fetch a device-true render (real responsive keys, not a narrow desktop).
   */
  async function handlePreviewDeviceChange(dev) {
    setPreviewDevice(dev);
    previewDeviceReqRef.current = dev;
    const ctx = previewCtxRef.current;
    if (!ctx) return;
    const cached = ctx.cache[dev];
    if (cached != null) {
      setPreviewHtml(cached);
      setPreviewError(null);
      setPreviewDeviceBusy(false); // an in-flight fetch for another device no longer owns the spinner
      return;
    }
    setPreviewDeviceBusy(true);
    setPreviewError(null);
    try {
      const { html } = await previewPage(ctx.pageJson, { device: dev, interactive: ctx.interactive });
      const doc = html || NO_PREVIEW_HTML;
      ctx.cache[dev] = doc;
      // Stale guard: the modal may have closed or the device switched again.
      if (previewOpenRef.current && previewCtxRef.current === ctx && previewDeviceReqRef.current === dev) {
        setPreviewHtml(doc);
      }
    } catch (e) {
      if (previewOpenRef.current && previewDeviceReqRef.current === dev) {
        setPreviewError((e && e.message) || 'Could not render this device preview.');
      }
    } finally {
      if (previewDeviceReqRef.current === dev) setPreviewDeviceBusy(false);
    }
  }

  async function handlePreview(pageJson) {
    const json = pageJson || (activeResult && activeResult.rawJson);
    if (!json) return;
    setPreviewBusy(true);
    setError(null);
    try {
      await openPreviewForJson(json, true); // result pages get click-to-select
    } catch (e) {
      setError({ message: e.message });
    } finally {
      setPreviewBusy(false);
    }
  }

  /* ---- Colors & fonts source (Elementor globals) ---- */

  async function selectGlobalsSource() {
    setGlobalsNotice('');
    // Mutually exclusive with a saved brand — site globals win when chosen.
    if (myBrandId) {
      setMyBrandId('');
      setBrandHint('Using site globals — the saved-brand selection was cleared.');
    }
    setColorSource('globals');
    if (globals) return; // already fetched + available
    setGlobalsLoading(true);
    try {
      const g = await getGlobals();
      // Treat an "available" but EMPTY kit (no colors, no fonts) as unavailable —
      // otherwise the user thinks site globals are applied when nothing would be.
      const colors = g ? [...(g.system_colors || []), ...(g.custom_colors || [])].filter((c) => c && c.color) : [];
      const fonts = g ? [...(g.system_typography || []), ...(g.custom_typography || [])].filter((t) => t && t.typography_font_family) : [];
      if (!g || !g.available || (colors.length === 0 && fonts.length === 0)) {
        setGlobalsNotice((g && g.message) ||
          (g && g.available
            ? 'This site has no Elementor global colors/fonts configured yet — using a new palette instead.'
            : 'Elementor global settings are not available on this site.'));
        setColorSource('new');
      } else {
        setGlobals(g);
      }
    } catch (e) {
      const msg = String((e && e.message) || '');
      setGlobalsNotice(msg.includes('Not connected')
        ? 'Your session expired (the local server restarted). Go to the Connect screen and click Test connection, then retry.'
        : (msg || 'Could not load Elementor globals.'));
      setColorSource('new');
    } finally {
      setGlobalsLoading(false);
    }
  }

  const globalColors = globals
    ? [...(globals.system_colors || []), ...(globals.custom_colors || [])].filter((c) => c && c.color)
    : [];
  const globalFontNames = globals
    ? [...new Set(
        [...(globals.system_typography || []), ...(globals.custom_typography || [])]
          .map((t) => t && t.typography_font_family)
          .filter(Boolean),
      )]
    : [];

  /* ---- Component library ---- */

  async function loadComponents() {
    setComponentsLoading(true);
    setComponentsError(null);
    try {
      // Organized by type: group the library by section type, then name.
      const list = await listComponents();
      setComponents(list.slice().sort((a, b) =>
        String(a.type || '').localeCompare(String(b.type || '')) ||
        String(a.name || '').localeCompare(String(b.name || ''))));
    } catch (e) {
      setComponentsError(e.message);
    } finally {
      setComponentsLoading(false);
    }
  }

  function toggleComponentsPanel() {
    const next = !componentsOpen;
    setComponentsOpen(next);
    if (next && components.length === 0 && !componentsLoading) loadComponents();
  }

  function toggleComponentSelected(id) {
    const key = String(id);
    setSelectedComponentIds((cur) => (
      cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]
    ));
  }

  async function handleDeleteComponent(id) {
    setLibBusy(true);
    setComponentsError(null);
    try {
      await deleteComponent(id);
      setComponents((cur) => cur.filter((c) => String(c.id) !== String(id)));
      setSelectedComponentIds((cur) => cur.filter((x) => x !== String(id)));
    } catch (e) {
      setComponentsError(e.message);
    } finally {
      setLibBusy(false);
    }
  }

  function openSaveComponent(sec) {
    setSaveCompFor(sec.id);
    setSaveCompName(sec.label);
    setSaveCompType('other');
    setSaveCompError(null);
  }

  async function handleSaveComponent(sec) {
    const el = workingContent.find((e) => e && e.id === sec.id);
    if (!el) {
      setSaveCompError('Could not find that section in the page JSON.');
      return;
    }
    setSaveCompBusy(true);
    setSaveCompError(null);
    try {
      await saveComponent({ name: saveCompName.trim() || sec.label, type: saveCompType, element: el });
      setSaveCompFor(null);
      setCompSavedNotice(true);
      if (compSavedTimer.current) clearTimeout(compSavedTimer.current);
      compSavedTimer.current = setTimeout(() => setCompSavedNotice(false), 3000);
      // Keep the library panel in sync if it has been loaded already.
      if (componentsOpen || components.length > 0) loadComponents();
    } catch (e) {
      setSaveCompError(e.message);
    } finally {
      setSaveCompBusy(false);
    }
  }

  /* ---- Saved brands (My brands) ---- */

  function handleSelectMyBrand(id) {
    setMyBrandId(id);
    setBrandError(null);
    if (id && colorSource === 'globals') {
      // Mutually exclusive with site globals — the saved brand wins.
      setColorSource('new');
      setGlobalsNotice('');
      setBrandHint('Saved brand selected — Colors & fonts switched back to “New palette”.');
    } else {
      setBrandHint('');
    }
  }

  async function handleSaveBrand() {
    const name = brandSaveName.trim();
    if (!name) return;
    setBrandSaveBusy(true);
    setBrandError(null);
    try {
      const ctx = composeBrandContext();
      // Capture COLORS + FONTS too: if a preset brand kit is selected, its
      // palette/fonts become part of the saved brand (backend supports both).
      const kit = brandKitId ? brandKits.find((k) => k.id === brandKitId) : null;
      const scope = brandSaveShared ? 'all' : 'site';
      const r = await saveBrand({
        name,
        context: ctx || undefined,
        palette: kit && kit.palette ? kit.palette : undefined,
        fonts: kit && kit.fonts ? kit.fonts : undefined,
        scope,
      });
      const id = r && r.id != null ? String(r.id) : '';
      const fresh = await listBrands().catch(() => null);
      if (Array.isArray(fresh)) setMyBrands(fresh);
      else if (id) setMyBrands((cur) => [...cur, { id, name, context: ctx, scope }]);
      if (id) handleSelectMyBrand(id);
      setBrandSaveOpen(false);
      setBrandSaveName('');
      setBrandSaveShared(false);
    } catch (e) {
      setBrandError(e.message);
    } finally {
      setBrandSaveBusy(false);
    }
  }

  async function handleDeleteBrand(id) {
    setBrandBusy(true);
    setBrandError(null);
    try {
      await deleteBrand(id);
      setMyBrands((cur) => cur.filter((b) => String(b.id) !== String(id)));
      if (String(myBrandId) === String(id)) setMyBrandId('');
      if (String(brandEditId) === String(id)) setBrandEditId(null);
    } catch (e) {
      setBrandError(e.message);
    } finally {
      setBrandBusy(false);
    }
  }

  /** Open the per-brand edit mini-form, prefilled from the saved brand. */
  function openBrandEdit(b) {
    setBrandEditId(String(b.id));
    setBrandEditName(b.name || '');
    setBrandEditUpdateCtx(false); // context is only re-captured when the user opts in
    setBrandEditShared(b.scope === 'all');
    setBrandError(null);
  }

  async function handleUpdateBrand() {
    const id = brandEditId;
    const name = brandEditName.trim();
    if (!id || !name || brandEditBusy) return;
    setBrandEditBusy(true);
    setBrandError(null);
    try {
      const patch = { name, scope: brandEditShared ? 'all' : 'site' };
      if (brandEditUpdateCtx) {
        const ctx = composeBrandContext();
        if (ctx) patch.context = ctx;
      }
      await updateBrand(id, patch);
      const fresh = await listBrands().catch(() => null);
      if (Array.isArray(fresh)) setMyBrands(fresh);
      else {
        setMyBrands((cur) => cur.map((b) => (String(b.id) === String(id)
          ? { ...b, name, scope: patch.scope, ...(patch.context ? { context: patch.context } : {}) }
          : b)));
      }
      setBrandEditId(null);
    } catch (e) {
      setBrandError(e.message);
    } finally {
      setBrandEditBusy(false);
    }
  }

  /** Jump into bulk-redesign mode with the active brand kept selected. */
  function handleRegenerateWithBrand() {
    if (!myBrandId) return;
    setMode('edit');
    setBulkMode(true);
    setBrandHint('Pick the pages to redesign with this brand, write the instruction, then Apply.');
  }

  /* ---- Bulk redesign ---- */

  function toggleBulkPage(id) {
    const key = String(id);
    setBulkPageIds((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));
  }

  /* ---- Scan a website for references ---- */

  /** Scan a URL into reference images (+ optional design-hint text). Shared by
   *  the main scan box and per-page scans in multi-page mode. */
  async function scanToImages(url, currentCount) {
    const data = await scanWebsite(url);
    const scanned = Array.isArray(data && data.images)
      ? data.images.filter((im) => im && im.base64)
      : [];
    const room = MAX_IMAGES - currentCount;
    if (scanned.length > 0 && room <= 0) {
      throw new Error(`Limit is ${MAX_IMAGES} references — remove one first.`);
    }
    const next = scanned.slice(0, Math.max(0, room)).map((im) => {
      const mediaType = im.mediaType || 'image/png';
      return {
        base64: im.base64,
        mediaType,
        name: im.name || url,
        preview: `data:${mediaType};base64,${im.base64}`,
      };
    });
    const hints = (data && data.hints) || {};
    const fonts = Array.isArray(hints.fonts) ? hints.fonts.filter(Boolean) : [];
    const colors = Array.isArray(hints.colors) ? hints.colors.filter(Boolean) : [];
    let hintText = '';
    if (fonts.length > 0 || colors.length > 0) {
      const parts = [];
      if (fonts.length > 0) parts.push(`fonts ${fonts.join(', ')}`);
      if (colors.length > 0) parts.push(`colors ${colors.join(', ')}`);
      hintText = `Design hints from scan: ${parts.join(', ')}`;
    }
    return { next, hintText };
  }

  async function handleScan() {
    const url = scanUrl.trim();
    if (!url) return;
    setScanBusy(true);
    setScanError(null);
    try {
      const { next, hintText } = await scanToImages(url, images.length);
      if (next.length) setImages((cur) => [...cur, ...next].slice(0, MAX_IMAGES));
      if (hintText) setPrompt((p) => `${p}\n${hintText}`);
      setScanUrl('');
    } catch (e) {
      setScanError(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  /** Multi-page: scan a URL into ONE page's references. */
  async function handlePageScan(pageId) {
    const pg = sitePages.find((x) => x.id === pageId);
    const url = pg ? pg.scanUrl.trim() : '';
    if (!url) return;
    patchSitePage(pageId, { scanBusy: true, scanError: '' });
    try {
      const { next } = await scanToImages(url, pg.images.length);
      patchSitePage(pageId, (x) => ({
        images: [...x.images, ...next].slice(0, MAX_IMAGES), scanUrl: '', scanBusy: false,
      }));
    } catch (e) {
      patchSitePage(pageId, { scanBusy: false, scanError: e.message });
    }
  }

  /* ---- Section reorder ---- */

  /** Swap two neighbors of the LOCAL content copy. `index` is the position in workingContent. */
  function moveSection(index, dir) {
    const j = index + dir;
    if (index < 0 || j < 0 || index >= workingContent.length || j >= workingContent.length) return;
    const arr = [...workingContent];
    [arr[index], arr[j]] = [arr[j], arr[index]];
    setOrderedContent(arr);
    setOrderDirty(true);
    setOrderError(null);
  }

  /** Drag-and-drop reorder: drop the dragged row at `targetIdx` (the ↑↓ buttons stay as fallback). */
  function handleSectionDrop(targetIdx) {
    const from = dragIdx;
    setDragIdx(null);
    setDragOverIdx(null);
    if (from == null || from === targetIdx) return;
    if (from < 0 || from >= workingContent.length || targetIdx < 0 || targetIdx >= workingContent.length) return;
    const arr = [...workingContent];
    const [moved] = arr.splice(from, 1);
    arr.splice(targetIdx, 0, moved);
    setOrderedContent(arr);
    setOrderDirty(true);
    setOrderError(null);
  }

  async function applyNewOrder() {
    if (!activeResult || !orderedContent) return;
    const inBatch = !!batch;
    const idx = activeIdx;
    const cur = activeResult;
    const pageJson = { ...cur.rawJson, content: orderedContent };
    setOrderBusy(true);
    setOrderError(null);
    try {
      const r = await republishPage(cur.pageId, pageJson);
      applyResultUpdate({
        ...cur,
        rawJson: pageJson,
        pageId: (r && r.pageId) || cur.pageId,
        pageUrl: (r && r.pageUrl) || cur.pageUrl,
        editorUrl: (r && r.editorUrl) || cur.editorUrl,
        status: (r && r.status) || cur.status,
      }, inBatch, idx);
      setOrderedContent(null);
      setOrderDirty(false);
      setRedoStack([]); // a NEW reorder invalidates any redo trail
      // A republish appends a version server-side — refresh the list if open.
      if (historyOpen) loadHistory((r && r.pageId) || cur.pageId);
    } catch (e) {
      setOrderError(e.message);
    } finally {
      setOrderBusy(false);
    }
  }

  /* ---- AI suggestions ---- */

  async function handleSuggest() {
    if (!activeResult || !activeResult.rawJson) return;
    setSuggestOpen(true);
    setSuggestBusy(true);
    setSuggestError(null);
    setSuggestions(null);
    try {
      const list = await getSuggestions(activeResult.rawJson, prompt || undefined);
      setSuggestions(list.filter((s) => s && (s.text || s.refinePrompt)));
    } catch (e) {
      setSuggestError(e.message);
    } finally {
      setSuggestBusy(false);
    }
  }

  function toggleSuggest() {
    if (suggestOpen) setSuggestOpen(false);
    else handleSuggest();
  }

  function applySuggestion(sg) {
    if (!sg || !sg.refinePrompt || running) return;
    runRefineFlow(sg.refinePrompt, ''); // whole page
  }

  /* ---- Version history ---- */

  async function loadHistory(pid) {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistoryVersions(await getHistory(pid));
    } catch (e) {
      setHistoryError(e.message);
    } finally {
      setHistoryLoading(false);
    }
  }

  function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    setRestoredNotice(false);
    if (next && activeResult && activeResult.pageId) loadHistory(activeResult.pageId);
  }

  async function handleVersionPreview(versionId) {
    if (!activeResult) return;
    setVersionBusy(`p:${versionId}`);
    setHistoryError(null);
    try {
      const version = await getHistoryVersion(activeResult.pageId, versionId);
      if (!version || !version.pageJson) throw new Error('This version has no stored page JSON.');
      await openPreviewForJson(version.pageJson, false); // history previews are NOT click-to-select
    } catch (e) {
      setHistoryError(e.message);
    } finally {
      setVersionBusy(null);
    }
  }

  async function handleRestore(versionId) {
    if (!activeResult) return;
    const inBatch = !!batch;
    const idx = activeIdx;
    const cur = activeResult;
    setVersionBusy(`r:${versionId}`);
    setHistoryError(null);
    setRestoredNotice(false);
    try {
      const r = await restoreVersion(cur.pageId, versionId);
      applyResultUpdate({
        ...cur,
        pageId: (r && r.pageId) || cur.pageId,
        pageUrl: (r && r.pageUrl) || cur.pageUrl,
        editorUrl: (r && r.editorUrl) || cur.editorUrl,
        status: (r && r.status) || cur.status,
      }, inBatch, idx);
      setRestoredNotice(true);
      if (restoredTimer.current) clearTimeout(restoredTimer.current);
      restoredTimer.current = setTimeout(() => setRestoredNotice(false), 4000);
      // A restore appends a 'refine' version server-side — refresh the list.
      loadHistory((r && r.pageId) || cur.pageId);
    } catch (e) {
      setHistoryError(e.message);
    } finally {
      setVersionBusy(null);
    }
  }

  /* ---- Undo / redo (backed by version history) ---- */

  function showUndoNotice(text) {
    setUndoNotice(text);
    if (undoNoticeTimer.current) clearTimeout(undoNoticeTimer.current);
    undoNoticeTimer.current = setTimeout(() => setUndoNotice(''), 4000);
  }

  /** Refresh the result card's links after a restore-based undo/redo. */
  function applyRestoreResult(r, cur, inBatch, idx) {
    applyResultUpdate({
      ...cur,
      pageId: (r && r.pageId) || cur.pageId,
      pageUrl: (r && r.pageUrl) || cur.pageUrl,
      editorUrl: (r && r.editorUrl) || cur.editorUrl,
      status: (r && r.status) || cur.status,
    }, inBatch, idx);
    if (historyOpen) loadHistory((r && r.pageId) || cur.pageId);
  }

  /** Undo = restore versions[1] (the one right before the live version). */
  async function handleUndo() {
    if (!activeResult || !activeResult.pageId || undoRedoBusy || running) return;
    const inBatch = !!batch;
    const idx = activeIdx;
    const cur = activeResult;
    setUndoRedoBusy('undo');
    setError(null);
    setUndoNotice('');
    try {
      const versions = await getHistory(cur.pageId);
      if (!Array.isArray(versions) || versions.length < 2) {
        showUndoNotice('Nothing to undo yet — this page has no earlier version.');
        return;
      }
      const current = versions[0] && versions[0].versionId;
      const target = versions[1];
      const r = await restoreVersion(cur.pageId, target.versionId);
      if (current != null) setRedoStack((s) => [...s, current]);
      setUndoStack((s) => [...s, target.versionId]);
      applyRestoreResult(r, cur, inBatch, idx);
      showUndoNotice('Undone — restored the previous version.');
    } catch (e) {
      setError({ message: e.message });
    } finally {
      setUndoRedoBusy(null);
    }
  }

  /** Redo = restore the last version pushed by Undo. */
  async function handleRedo() {
    if (!activeResult || !activeResult.pageId || undoRedoBusy || running || redoStack.length === 0) return;
    const inBatch = !!batch;
    const idx = activeIdx;
    const cur = activeResult;
    const popped = redoStack[redoStack.length - 1];
    setUndoRedoBusy('redo');
    setError(null);
    setUndoNotice('');
    try {
      const r = await restoreVersion(cur.pageId, popped);
      setRedoStack((s) => s.slice(0, -1)); // pop only once the restore succeeded
      applyRestoreResult(r, cur, inBatch, idx);
      showUndoNotice('Redone.');
    } catch (e) {
      setError({ message: e.message });
    } finally {
      setUndoRedoBusy(null);
    }
  }

  /** Make a finished batch card the 'active result' for refine/history/download. */
  function selectBatchItem(i) {
    if (!batch) return;
    const it = batch.items[i];
    if (!it || it.status !== 'done' || !it.result) return;
    if (i === activeIdx) return;
    setActiveIdx(i);
    // Panels are page-scoped — reset them when the active page changes.
    setHistoryOpen(false);
    setHistoryVersions([]);
    setHistoryError(null);
    setRestoredNotice(false);
    setRefineTarget('');
    setSuggestOpen(false);
    setSuggestions(null);
    setSuggestError(null);
    setOrderedContent(null);
    setOrderDirty(false);
    setOrderError(null);
    setSaveCompFor(null);
    setSaveCompError(null);
    // Undo/redo stacks hold versionIds of ONE page — drop them on switch.
    setUndoStack([]);
    setRedoStack([]);
    setUndoNotice('');
    setRefineNotice('');
  }

  /* ---- Side-by-side compare (batch results + history versions) ---- */

  const compareOptions = [];
  if (batch) {
    batch.items.forEach((it, i) => {
      if (it.status === 'done' && it.result && it.result.rawJson) {
        compareOptions.push({ key: `b:${i}`, kind: 'batch', index: i, label: it.name });
      }
    });
  }
  if (historyOpen && activeResult) {
    historyVersions.forEach((v) => {
      compareOptions.push({
        key: `v:${v.versionId}`,
        kind: 'version',
        versionId: v.versionId,
        label: `v ${formatTs(v.ts)} — ${v.summary || v.title || v.source || 'version'}`,
      });
    });
  }
  const compareBatchCount = compareOptions.filter((o) => o.kind === 'batch').length;
  const canCompare = compareBatchCount >= 2 || (historyOpen && historyVersions.length >= 2);

  function patchCompareSide(side, patch) {
    setCompareSides((s) => ({ ...s, [side]: { ...s[side], ...patch } }));
  }

  /** Fetch + render one side of the compare modal (desktop render, cached per option). */
  /** Batch option + page json for a compare side (transplant works between variation drafts). */
  function compareSideBatch(side) {
    const opt = compareOptions.find((o) => o.key === compareSel[side]);
    if (!opt || opt.kind !== 'batch') return null;
    const it = batch && batch.items[opt.index];
    if (!it || !it.result || !it.result.rawJson || !it.result.pageId) return null;
    return { opt, item: it, json: it.result.rawJson, pageId: it.result.pageId };
  }

  /** Top-level sections of a side, labeled by their first heading. */
  function compareSideSections(side) {
    const src = compareSideBatch(side);
    if (!src || !Array.isArray(src.json.content)) return [];
    return src.json.content.map((band, i) => {
      let label = '';
      (function walk(el) {
        if (label || !el || typeof el !== 'object') return;
        if (el.widgetType === 'heading' && el.settings && el.settings.title) {
          label = String(el.settings.title).replace(/<[^>]+>/g, '').slice(0, 42);
          return;
        }
        (el.elements || []).forEach(walk);
      })(band);
      return { id: band.id, label: `${i + 1}. ${label || '(no heading)'}` };
    });
  }

  /** Copy the given section from `side` into the OTHER side's draft page. */
  async function transplantSection(side, sectionId) {
    const other = side === 'left' ? 'right' : 'left';
    const source = compareSideBatch(side);
    const target = compareSideBatch(other);
    if (!source || !target || !sectionId) return;
    const section = source.json.content.find((b) => b && b.id === sectionId);
    if (!section) return;
    setTransplantBusy(true);
    setTransplantMsg(null);
    try {
      const res = await copySection(target.pageId, section);
      // Update the target variation's JSON in batch state + refresh its preview.
      setBatch((b) => patchBatchItem(b, target.opt.index, {
        result: { ...target.item.result, rawJson: { ...target.json, content: res.content } },
      }));
      delete compareCacheRef.current[target.opt.key];
      const { html } = await previewPage({ ...target.json, content: res.content }, { device: 'desktop' });
      compareCacheRef.current[target.opt.key] = html || NO_PREVIEW_HTML;
      patchCompareSide(other, { busy: false, html: html || NO_PREVIEW_HTML, error: null });
      setTransplantSel((t) => ({ ...t, [side]: '' }));
      setTransplantMsg({
        side,
        ok: true,
        text: res.mode === 'replaced'
          ? `Replaced the matching section in ${target.opt.label} — saved.`
          : `Added as a new section to ${target.opt.label} — saved.`,
      });
    } catch (e) {
      setTransplantMsg({ side, ok: false, text: `Copy failed: ${(e && e.message) || 'unknown error'}` });
    } finally {
      setTransplantBusy(false);
    }
  }

  async function loadCompareSide(side, key) {
    setCompareSel((s) => ({ ...s, [side]: key }));
    const token = (compareReqRef.current[side] || 0) + 1;
    compareReqRef.current[side] = token;
    const cached = compareCacheRef.current[key];
    if (cached) {
      patchCompareSide(side, { busy: false, html: cached, error: null });
      return;
    }
    patchCompareSide(side, { busy: true, html: null, error: null });
    try {
      const opt = compareOptions.find((o) => o.key === key);
      if (!opt) throw new Error('That option is no longer available.');
      let json;
      if (opt.kind === 'batch') {
        const it = batch && batch.items[opt.index];
        json = it && it.result && it.result.rawJson;
        if (!json) throw new Error('That result has no page JSON.');
      } else {
        const version = await getHistoryVersion(activeResult.pageId, opt.versionId);
        if (!version || !version.pageJson) throw new Error('This version has no stored page JSON.');
        json = version.pageJson;
      }
      const { html } = await previewPage(json, { device: 'desktop' });
      const doc = html || NO_PREVIEW_HTML;
      compareCacheRef.current[key] = doc;
      if (compareReqRef.current[side] === token) patchCompareSide(side, { busy: false, html: doc, error: null });
    } catch (e) {
      if (compareReqRef.current[side] === token) {
        patchCompareSide(side, { busy: false, html: null, error: (e && e.message) || 'Could not render.' });
      }
    }
  }

  function openCompare() {
    if (compareOptions.length < 2) return;
    setCompareOpen(true);
    setCompareSides({ left: COMPARE_SIDE_EMPTY, right: COMPARE_SIDE_EMPTY });
    loadCompareSide('left', compareOptions[0].key);
    loadCompareSide('right', compareOptions[1].key);
  }

  // Fit the fixed-width device viewport into the modal: scale down (never up)
  // so Desktop always shows the true desktop layout, just smaller.
  const deviceWidth = (DEVICES.find(([key]) => key === previewDevice) || DEVICES[0])[2];
  useLayoutEffect(() => {
    if (previewHtml === null) return undefined;
    const node = previewBodyRef.current;
    if (!node) return undefined;
    const update = () => {
      const w = node.clientWidth;
      setPreviewScale(w > 0 ? Math.min(1, w / deviceWidth) : 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [previewHtml, deviceWidth]);

  // Compare modal: fit a desktop-width iframe into HALF the modal — same
  // scale-to-fit approach as the preview modal, measured on one pane (both
  // panes share the grid track width).
  const desktopWidth = DEVICES[0][2];
  useLayoutEffect(() => {
    if (!compareOpen) return undefined;
    const node = comparePaneRef.current;
    if (!node) return undefined;
    const update = () => {
      const w = node.clientWidth;
      setCompareScale(w > 0 ? Math.min(1, w / desktopWidth) : 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [compareOpen, desktopWidth]);

  /* ---- Shared result-card fragments ---- */

  /* ---- AI component suggestions ---- */

  async function handleSuggestComponents() {
    if (!prompt.trim() || compSuggestBusy) return;
    setCompSuggestBusy(true);
    setCompSuggestError(null);
    setCompSuggestEmpty(false);
    try {
      let list = components;
      if (list.length === 0) {
        list = await listComponents();
        setComponents(list);
      }
      if (list.length === 0) {
        setCompSuggestError('Your library is empty — save a section from any result first.');
        return;
      }
      const picks = await suggestComponents(prompt);
      if (!picks.length) {
        setCompSuggestEmpty(true);
        setCompPicks({});
        return;
      }
      const reasonById = {};
      for (const p of picks) reasonById[String(p.id)] = p.reason || '';
      setCompPicks(reasonById);
      setSelectedComponentIds((cur) => [...new Set([...cur, ...picks.map((p) => String(p.id))])]);
    } catch (e) {
      setCompSuggestError(e.message);
    } finally {
      setCompSuggestBusy(false);
    }
  }

  /* ---- Pro-widget usage history ---- */

  async function toggleUsagePanel() {
    const opening = !usageOpen;
    setUsageOpen(opening);
    if (!opening || proUsage) return;
    setUsageBusy(true);
    setUsageError(null);
    try {
      setProUsage(await getProUsage());
    } catch (e) {
      setUsageError(e.message);
    } finally {
      setUsageBusy(false);
    }
  }

  /* ---- Site global widgets ---- */

  async function toggleGwPanel() {
    const opening = !gwOpen;
    setGwOpen(opening);
    if (!opening || gw) return;
    setGwBusy(true);
    setGwError(null);
    try {
      setGw(await getGlobalWidgets());
    } catch (e) {
      setGwError(e.message);
    } finally {
      setGwBusy(false);
    }
  }

  async function handleMakeGlobalWidget(c) {
    setGwCreateBusyId(c.id);
    setGwNotice('');
    setGwError(null);
    try {
      const created = await createGlobalWidget(c.id, c.name);
      setGwNotice(`Created global widget “${created.title}” — it will auto-sync wherever it's used.`);
      // Refresh the list so the new widget shows up immediately.
      try { setGw(await getGlobalWidgets()); } catch (_) { /* keep old list */ }
    } catch (e) {
      setGwError(e.message);
    } finally {
      setGwCreateBusyId(null);
    }
  }

  function renderProReport() {
    if (!activeResult) return null;
    const used = (activeResult.proWidgets && Array.isArray(activeResult.proWidgets.used))
      ? activeResult.proWidgets.used
      : [];
    // Use the flag from the RUN that produced this result (falls back to the
    // live toggle for older results that predate the per-run flag).
    const runAllowPro = activeResult.proWidgets && typeof activeResult.proWidgets.allowPro === 'boolean'
      ? activeResult.proWidgets.allowPro
      : allowPro;

    const usageBlock = (
      <>
        <button type="button" className="ghost small" onClick={toggleUsagePanel}>
          {usageOpen ? '▾' : '▸'} Usage history
        </button>
        {usageOpen && (
          <div className="usage-panel">
            {usageBusy && <p className="hint">Loading usage…</p>}
            {usageError && <div className="alert-error">{usageError}</div>}
            {!usageBusy && !usageError && proUsage && proUsage.runs === 0 && (
              <p className="hint">No Pro widget usage recorded yet.</p>
            )}
            {!usageBusy && !usageError && proUsage && proUsage.runs > 0 && (
              <>
                <p className="hint">
                  Across {proUsage.runs} generation{proUsage.runs === 1 ? '' : 's'}
                  {proUsage.since ? ` since ${formatTs(proUsage.since)}` : ''}
                </p>
                {proUsage.widgets.length === 0 && <p className="hint">No Pro widgets used in any run so far.</p>}
                {proUsage.widgets.length > 0 && (
                  <ul>
                    {proUsage.widgets.map((w, i) => (
                      <li key={i}>
                        <code>{w.widget}</code> — used in {w.runs} run{w.runs === 1 ? '' : 's'}, ×{w.totalCount} total
                        {w.freeAlternative ? <> — free alternative: <code>{w.freeAlternative}</code></> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="pro-report-note">{proUsageVerdict(proUsage)}</p>
              </>
            )}
          </div>
        )}
      </>
    );

    return (
      <div className="pro-report">
        {used.length > 0 ? (
          <>
            <div className="pro-report-title">Pro widgets used</div>
            <ul>
              {used.map((u, i) => (
                <li key={i}>
                  <code>{u.widget}</code> ×{u.count || 1}
                  {u.freeAlternative ? <> — free alternative: <code>{u.freeAlternative}</code></> : null}
                </li>
              ))}
            </ul>
          </>
        ) : !runAllowPro ? (
          <p className="pro-report-note">Pro widgets are OFF — this page uses free widgets only.</p>
        ) : (
          <p className="pro-report-note">No Pro widgets on this page.</p>
        )}
        {usageBlock}
      </div>
    );
  }

  function renderHistoryPanel() {
    if (!historyOpen || !activeResult) return null;
    return (
      <div className="history-panel">
        <div className="history-head">
          <span className="history-title">Version history</span>
          {restoredNotice && <span className="restored-notice">✓ Restored</span>}
          <button
            className="ghost small"
            onClick={() => loadHistory(activeResult.pageId)}
            disabled={historyLoading}
          >
            Refresh
          </button>
        </div>
        {historyLoading && <p className="hint">Loading versions…</p>}
        {historyError && <div className="alert-error">{historyError}</div>}
        {!historyLoading && !historyError && historyVersions.length === 0 && (
          <p className="hint">No saved versions for this page yet — each generate/refine adds one.</p>
        )}
        {!historyLoading && historyVersions.length > 0 && (
          <ul className="history-list">
            {historyVersions.map((v) => (
              <li key={v.versionId} className="history-row">
                <div className="history-meta">
                  <span className={`history-badge ${v.source || ''}`}>{v.source || 'version'}</span>
                  <span className="history-ts">{formatTs(v.ts)}</span>
                </div>
                <div className="history-summary">{v.summary || v.title || '—'}</div>
                <div className="history-actions">
                  <button
                    className="ghost small"
                    disabled={versionBusy !== null}
                    onClick={() => handleVersionPreview(v.versionId)}
                  >
                    {versionBusy === `p:${v.versionId}` ? 'Rendering…' : 'Preview'}
                  </button>
                  <button
                    className="ghost small"
                    disabled={versionBusy !== null || running}
                    onClick={() => handleRestore(v.versionId)}
                  >
                    {versionBusy === `r:${v.versionId}` ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  function renderSectionsPanel() {
    if (!activeResult || sections.length === 0) return null;
    const lastIdx = workingContent.length - 1;
    return (
      <div className="sections-panel">
        <div className="sections-head">
          <span className="sections-title">Sections</span>
          {compSavedNotice && <span className="restored-notice">✓ Saved to library</span>}
          {orderDirty && <span className="order-flag">Unsaved order</span>}
        </div>
        <ul className="section-list">
          {sections.map((s) => {
            const i = s.n - 1; // index in workingContent
            const rowClass = [
              'section-row',
              dragIdx === i ? 'dragging' : '',
              (dragOverIdx === i && dragIdx !== null && dragIdx !== i) ? 'drag-over' : '',
            ].join(' ').trim();
            return (
            <li
              key={s.id}
              className={rowClass}
              draggable={!running && !orderBusy}
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) { /* older engines */ }
              }}
              onDragOver={(e) => {
                e.preventDefault(); // required so drop fires
                e.dataTransfer.dropEffect = 'move';
                if (dragOverIdx !== i) setDragOverIdx(i);
              }}
              onDragLeave={() => { if (dragOverIdx === i) setDragOverIdx(null); }}
              onDrop={(e) => { e.preventDefault(); handleSectionDrop(i); }}
              onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
            >
              <span className="drag-handle" title="Drag to reorder">⠿</span>
              <span className="section-order">
                <button
                  type="button"
                  className="order-btn"
                  title="Move up"
                  disabled={running || orderBusy || s.n - 1 === 0}
                  onClick={() => moveSection(s.n - 1, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="order-btn"
                  title="Move down"
                  disabled={running || orderBusy || s.n - 1 === lastIdx}
                  onClick={() => moveSection(s.n - 1, 1)}
                >
                  ↓
                </button>
              </span>
              <span className="section-label">{`${s.n}. ${s.label}`}</span>
              <button
                type="button"
                className="ghost small"
                disabled={saveCompBusy}
                onClick={() => (saveCompFor === s.id ? setSaveCompFor(null) : openSaveComponent(s))}
              >
                Save to library
              </button>
              {saveCompFor === s.id && (
                <div className="comp-form">
                  <div className="comp-form-row">
                    <input
                      className="input"
                      placeholder="Component name"
                      value={saveCompName}
                      onChange={(e) => setSaveCompName(e.target.value)}
                    />
                    <select
                      className="input"
                      value={saveCompType}
                      onChange={(e) => setSaveCompType(e.target.value)}
                    >
                      {COMPONENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="comp-form-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={saveCompBusy || !saveCompName.trim()}
                      onClick={() => handleSaveComponent(s)}
                    >
                      {saveCompBusy ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" className="ghost small" onClick={() => setSaveCompFor(null)}>Cancel</button>
                  </div>
                  {saveCompError && <div className="alert-error">{saveCompError}</div>}
                </div>
              )}
            </li>
            );
          })}
        </ul>
        {orderDirty && (
          <button
            type="button"
            className="secondary order-apply"
            disabled={orderBusy || running}
            onClick={applyNewOrder}
          >
            {orderBusy ? 'Applying…' : 'Apply new order'}
          </button>
        )}
        {orderError && <div className="alert-error">{orderError}</div>}
      </div>
    );
  }

  function renderSuggestPanel() {
    if (!suggestOpen || !activeResult) return null;
    return (
      <div className="suggest-panel">
        <div className="suggest-head">
          <span className="suggest-title">AI suggestions</span>
          <button type="button" className="ghost small" onClick={handleSuggest} disabled={suggestBusy || running}>
            Refresh
          </button>
          <button type="button" className="ghost small" onClick={() => setSuggestOpen(false)}>Close</button>
        </div>
        {suggestBusy && <p className="hint">Reviewing the page for improvements…</p>}
        {suggestError && <div className="alert-error">{suggestError}</div>}
        {!suggestBusy && !suggestError && suggestions && suggestions.length === 0 && (
          <p className="hint">No suggestions — the page looks solid.</p>
        )}
        {!suggestBusy && suggestions && suggestions.length > 0 && (
          <div className="suggest-grid">
            {suggestions.map((sg, i) => (
              <div key={i} className="suggest-card">
                <p className="suggest-text">{sg.text || sg.refinePrompt}</p>
                <button
                  type="button"
                  className="ghost small"
                  disabled={running || !sg.refinePrompt}
                  onClick={() => applySuggestion(sg)}
                >
                  Apply
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Progress for a suggestion-applied refine (the refine panel shows its own) */}
        {running && !refineOpen && <Stepper stage={stage} detail={stageDetail} />}
      </div>
    );
  }

  /** ↶ Undo / ↷ Redo / Compare — shared by the single-result and batch action rows. */
  function renderUndoRedoCompare() {
    const pid = activeResult && activeResult.pageId;
    const busy = running || undoRedoBusy !== null;
    return (
      <>
        <button
          className="secondary"
          onClick={handleUndo}
          disabled={busy || !pid}
          title="Restore the previous version"
        >
          {undoRedoBusy === 'undo' ? 'Undoing…' : '↶ Undo'}
        </button>
        <button
          className="secondary"
          onClick={handleRedo}
          disabled={busy || !pid || redoStack.length === 0}
          title={redoStack.length === 0 ? 'Nothing to redo' : 'Restore the version you just undid'}
        >
          {undoRedoBusy === 'redo' ? 'Redoing…' : '↷ Redo'}
        </button>
        {canCompare && (
          <button className="secondary" onClick={openCompare} title="Compare two results side by side">
            Compare
          </button>
        )}
      </>
    );
  }

  function renderRefinePanel() {
    if (!refineOpen || !activeResult) return null;
    return (
      <div className="refine" ref={refinePanelRef}>
        {refineNotice && <p className="refine-notice">✓ {refineNotice}</p>}
        {sections.length > 0 && (
          <div>
            <label className="label">Refine a specific section</label>
            <select
              className="input"
              value={refineTarget}
              onChange={(e) => {
                setRefineTarget(e.target.value);
                if (e.target.value) scrollRefineIntoView();
              }}
            >
              <option value="">Whole page</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>{`Section ${s.n} — ${s.label}`}</option>
              ))}
            </select>
          </div>
        )}
        <textarea
          ref={refineInputRef}
          className="input textarea"
          rows={3}
          placeholder={refineTarget
            ? 'Describe the tweak for this section only, e.g. make its heading larger'
            : 'Describe the tweak, e.g. make the hero taller and swap accent to green'}
          value={refinePrompt}
          onChange={(e) => setRefinePrompt(e.target.value)}
        />
        <button className="primary" onClick={handleRefine} disabled={running || !refinePrompt.trim()}>
          {running ? 'Working…' : 'Send refinement'}
        </button>
        {/* Same stage progress as generate, shown while a refine runs */}
        {running && <Stepper stage={stage} detail={stageDetail} />}
      </div>
    );
  }

  const batchDone = batch ? batch.items.filter((it) => it.status === 'done').length : 0;

  const generateLabel = running ? 'Working…'
    : (bulkActive && bulkPageIds.length > 0) ? `Redesign ${bulkPageIds.length} page${bulkPageIds.length > 1 ? 's' : ''}`
    : mode === 'edit' ? 'Apply changes'
    : (multiActive && parsedPageNames.length > 0) ? `Generate ${parsedPageNames.length} page${parsedPageNames.length > 1 ? 's' : ''}`
    : variationsActive ? `Generate ${variations} variations`
    : 'Generate page';

  return (
    <div className="card wide">
      <h1 className="title">Build a page</h1>

      {/* Mode */}
      <div className="seg">
        <button className={mode === 'new' ? 'seg-btn active' : 'seg-btn'} onClick={() => setMode('new')}>New page</button>
        <button className={mode === 'edit' ? 'seg-btn active' : 'seg-btn'} onClick={() => setMode('edit')}>Edit existing</button>
      </div>

      {mode === 'edit' && (
        <>
          {!bulkMode && (
            <>
              <label className="label">Which page?</label>
              <select className="input" value={pageId} onChange={(e) => setPageId(e.target.value)}>
                <option value="">Select a page…</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>{pageOptionLabel(p)} — {p.status}</option>
                ))}
              </select>
              {(() => {
                const sel = pages.find((p) => String(p.id) === String(pageId));
                return sel && sel.built_with_elementor === false ? (
                  <p className="hint">
                    This page was built with another builder/editor. Its content will be imported
                    and rebuilt as native Elementor containers; the original is preserved and the
                    page is snapshotted to History first.
                  </p>
                ) : null;
              })()}
            </>
          )}

          {/* Bulk redesign: one instruction, several pages */}
          <div className={bulkMode ? 'multi-panel highlight' : 'multi-panel'}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={bulkMode}
                onChange={(e) => setBulkMode(e.target.checked)}
              />
              <span>Apply to multiple pages <span className="toggle-hint">redesign several pages with one instruction</span></span>
            </label>
            {bulkMode && (
              <>
                {pages.length === 0 && <p className="hint">No pages found on this site yet.</p>}
                {pages.length > 0 && (
                  <div className="bulk-list">
                    {pages.map((p) => (
                      <label key={p.id} className="toggle">
                        <input
                          type="checkbox"
                          checked={bulkPageIds.includes(String(p.id))}
                          onChange={() => toggleBulkPage(p.id)}
                        />
                        <span>{pageOptionLabel(p)} <span className="toggle-hint">{p.status}</span></span>
                      </label>
                    ))}
                  </div>
                )}
                {pages.some((p) => bulkPageIds.includes(String(p.id)) && p.built_with_elementor === false) && (
                  <p className="hint">
                    Some selected pages were built with another builder/editor — their content will be
                    imported and rebuilt as native Elementor containers (originals preserved, snapshots
                    saved to History first).
                  </p>
                )}
                <p className="hint">Slugs and SEO meta are untouched — only the Elementor layout is redesigned.</p>
              </>
            )}
          </div>
        </>
      )}

      <div className="build-grid">
      <div className="build-col-main">
      {/* Template library (starter briefs) */}
      {mode === 'new' && briefs.length > 0 && (
        <>
          <label className="label">Template library (starter briefs)</label>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const b = briefs.find((x) => x.id === e.target.value);
              if (b) setPrompt(b.brief);
            }}
          >
            <option value="">Choose a business type to prefill the brief…</option>
            {briefs.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <p className="hint">Pick a template, then edit the brief to fit your business.</p>
        </>
      )}

      {/* Prompt */}
      <label className="label">{mode === 'edit' ? 'What should change?' : 'Describe the page'}</label>
      <textarea
        className="input textarea"
        rows={5}
        placeholder={mode === 'edit'
          ? 'e.g. change the hero heading to “We design calm spaces” and make the accent navy'
          : 'Describe the business, sections, and style you want…'}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      {mode === 'new' && (
        <div className="chips">
          {EXAMPLES.map((ex, i) => (
            <button key={i} className="chip" onClick={() => setPrompt(ex)}>{ex.slice(0, 42)}…</button>
          ))}
        </div>
      )}

      {/* Image dropzone (Person 7) — single-page mode only. In multi-page mode
          every page carries its own references inside its own block. */}
      {mode === 'new' && !multiPage && (
        <>
          <label className="label">Mockup references (optional, up to {MAX_IMAGES})</label>
          <div
            className="dropzone"
            onClick={() => fileInput.current && fileInput.current.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
          >
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
            <span>PNG/JPG or PDF, up to 30 references — large images are auto-optimized, PDFs become one reference per page</span>
          </div>
          {images.length > 0 && (
            <div className="thumbs">
              {images.map((img, i) => (
                <div className="thumb" key={i}>
                  <img src={img.preview} alt={img.name} />
                  <button className="thumb-x" onClick={() => removeImage(i)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Scan a website: screenshots become references, hints go to the brief */}
          <div className="scan-row">
            <label className="label">or scan a website</label>
            <div className="input-row">
              <input
                className="input"
                placeholder="https://example.com — its screenshots become references"
                value={scanUrl}
                onChange={(e) => setScanUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScan(); } }}
              />
              <button
                type="button"
                className="secondary"
                onClick={handleScan}
                disabled={scanBusy || !scanUrl.trim()}
              >
                {scanBusy ? 'Scanning…' : 'Scan'}
              </button>
            </div>
            {scanError && <div className="alert-error">{scanError}</div>}
          </div>
        </>
      )}

      {/* Multi-page site */}
      {mode === 'new' && (
        <div className={multiPage ? 'multi-panel highlight' : 'multi-panel'}>
          <label className="label">How many pages?</label>
          <div className="seg">
            <button
              type="button"
              className={multiPage ? 'seg-btn' : 'seg-btn active'}
              onClick={() => setMultiPage(false)}
            >
              Single page
            </button>
            <button
              type="button"
              className={multiPage ? 'seg-btn active' : 'seg-btn'}
              onClick={() => { setMultiPage(true); setVariations(1); }}
            >
              Multiple pages
            </button>
          </div>
          {!multiPage && images.length > 1 && (
            <p className="hint">You attached {images.length} references — switch to Multiple pages to build a whole site in one run.</p>
          )}
          {multiPage && (
            <>
              <p className="hint">
                Every page is defined here — name it, then give it its own references
                (upload images or scan that page's URL). A page left without references
                reuses <b>Page 1's</b> references, so one design can drive a whole site.
                All other settings on the right (template, palette, widget mode, header,
                images, auto-refine) apply to <b>every</b> page.
              </p>
              {sitePages.map((pg, i) => (
                <div className="site-page" key={pg.id}>
                  <div className="site-page-head">
                    <span className="site-page-num" title={`Page ${i + 1}`}>{i + 1}</span>
                    <input
                      className="input"
                      placeholder={i === 0 ? 'Page name, e.g. Home' : 'Page name, e.g. About, Services, Contact'}
                      value={pg.name}
                      onChange={(e) => patchSitePage(pg.id, { name: e.target.value })}
                    />
                    {sitePages.length > 1 && (
                      <button
                        type="button"
                        className="ghost"
                        title="Remove this page"
                        onClick={() => setSitePages((cur) => cur.filter((x) => x.id !== pg.id))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div className="site-page-refs">
                    <label className="mini-drop">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,application/pdf"
                        multiple
                        hidden
                        onChange={(e) => { addPageFiles(pg.id, e.target.files); e.target.value = ''; }}
                      />
                      + Upload references for this page
                    </label>
                    <div className="input-row">
                      <input
                        className="input"
                        placeholder="or scan this page's URL, e.g. https://example.com/about"
                        value={pg.scanUrl}
                        onChange={(e) => patchSitePage(pg.id, { scanUrl: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePageScan(pg.id); } }}
                      />
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handlePageScan(pg.id)}
                        disabled={pg.scanBusy || !pg.scanUrl.trim()}
                      >
                        {pg.scanBusy ? 'Scanning…' : 'Scan'}
                      </button>
                    </div>
                    {pg.scanError && <div className="alert-error">{pg.scanError}</div>}
                    {pg.images.length > 0 ? (
                      <div className="thumbs small">
                        {pg.images.map((img, k) => (
                          <div className="thumb" key={k}>
                            <img src={img.preview} alt={img.name} />
                            <button className="thumb-x" onClick={() => removePageImage(pg.id, k)}>✕</button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="hint">
                        {i === 0
                          ? (images.length > 0
                            ? `No references of its own — this page will use the ${images.length} reference${images.length > 1 ? 's' : ''} you attached before switching to multi-page. Add images here to override.`
                            : 'No references yet — add images or scan a URL. Pages below with no references of their own will reuse these.')
                          : (sitePages[0] && sitePages[0].images.length
                            ? `No references of its own — this page will reuse Page 1's ${sitePages[0].images.length} reference${sitePages[0].images.length > 1 ? 's' : ''}.`
                            : 'No references yet — add images or scan a URL, or give Page 1 references for this page to reuse.')}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="secondary add-page-btn"
                onClick={() => setSitePages((cur) => [...cur, newSitePage('')])}
              >
                + Add another page
              </button>
              {unnamedCount > 0 && (
                <p className="hint warn">
                  {unnamedCount} page block{unnamedCount > 1 ? 's have' : ' has'} no name and will be SKIPPED — type a name or remove the block.
                </p>
              )}
              {duplicateNames.length > 0 && (
                <p className="hint warn">
                  Duplicate page name{duplicateNames.length > 1 ? 's' : ''}: {duplicateNames.join(', ')} — each page needs its own title or you get two pages with the same name in WordPress.
                </p>
              )}
              {parsedPageNames.length === 0
                ? <p className="hint">Name at least one page to generate.</p>
                : (
                  <p className="hint build-summary">
                    <b>{parsedPageNames.length} page{parsedPageNames.length > 1 ? 's' : ''} will be built:</b> {parsedPageNames.join(', ')} — in parallel, sharing one palette, typography, header and footer.
                  </p>
                )}
            </>
          )}
        </div>
      )}

      </div>
      <div className="build-col-side">
      {/* Options */}
      <div className="grid2">
        <div>
          <label className="label">Template</label>
          <select className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="canvas">Elementor Canvas</option>
            <option value="full_width">Elementor Full Width</option>
            <option value="default">Theme default</option>
          </select>
        </div>
        <div>
          <label className="label">Publish as</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">Draft</option>
            <option value="publish">Published</option>
          </select>
        </div>
      </div>

      {/* Colors & fonts source */}
      <label className="label">Colors &amp; fonts</label>
      <div className="seg">
        <button
          type="button"
          className={colorSource === 'new' ? 'seg-btn active' : 'seg-btn'}
          onClick={() => { setColorSource('new'); setGlobalsNotice(''); }}
        >
          New palette
        </button>
        <button
          type="button"
          className={colorSource === 'globals' ? 'seg-btn active' : 'seg-btn'}
          onClick={selectGlobalsSource}
          disabled={globalsLoading}
        >
          Site&apos;s Elementor globals
        </button>
      </div>
      {globalsLoading && <p className="hint">Checking the site&apos;s Elementor global settings…</p>}
      {globalsNotice && (
        <div className="alert-error alert-row">
          <span>{globalsNotice}</span>
          <button
            type="button"
            className="ghost small"
            onClick={selectGlobalsSource}
            disabled={globalsLoading}
          >
            Try again
          </button>
        </div>
      )}
      {useGlobalsActive && (
        <div className="globals-confirm">
          {globalColors.length > 0 && (
            <span className="swatch-strip">
              {globalColors.slice(0, 6).map((c, i) => (
                <span key={i} className="swatch" title={c.title || c.color} style={{ background: c.color }} />
              ))}
            </span>
          )}
          {globalFontNames.length > 0 && (
            <span className="globals-fonts">{globalFontNames.slice(0, 4).join(' · ')}</span>
          )}
          <span className="globals-fonts">— the page will use these global colors &amp; fonts.</span>
        </div>
      )}

      {/* Style & quality controls */}
      <div className="grid2">
        <div>
          <label className="label">Brand kit</label>
          <select
            className="input"
            value={brandKitId}
            onChange={(e) => setBrandKitId(e.target.value)}
            disabled={useGlobalsActive || !!myBrandId}
            title={myBrandId ? 'Using saved brand' : useGlobalsActive ? 'Using Elementor global settings' : ''}
          >
            <option value="">None</option>
            {brandKits.map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">My brands</label>
          <select
            className="input"
            value={myBrandId}
            onChange={(e) => handleSelectMyBrand(e.target.value)}
          >
            <option value="">None</option>
            {myBrands.map((b) => (
              <option key={b.id} value={String(b.id)}>
                {b.name}{b.scope === 'all' ? ' (shared)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Saved-brand chip + save/manage actions */}
      <div className="brand-actions">
        {activeBrand && (
          <span className="brand-chip">
            Brand: <strong>{activeBrand.name}</strong>
            {activeBrand.scope === 'all' && <span className="shared-badge">shared</span>}
            <button type="button" title="Stop using this brand" onClick={() => handleSelectMyBrand('')}>✕</button>
          </span>
        )}
        {activeBrand && (
          <button
            type="button"
            className="ghost small"
            onClick={handleRegenerateWithBrand}
            title="Redesign existing pages of this site with this brand"
          >
            Regenerate pages with this brand
          </button>
        )}
        <button
          type="button"
          className="ghost small"
          onClick={() => { setBrandSaveOpen((v) => !v); setBrandError(null); }}
        >
          Save current as brand…
        </button>
        {myBrands.length > 0 && (
          <button type="button" className="ghost small" onClick={() => setBrandManageOpen((v) => !v)}>
            {brandManageOpen ? 'Done managing' : 'Manage brands'}
          </button>
        )}
      </div>
      {brandHint && <p className="hint">{brandHint}</p>}
      {brandError && <div className="alert-error">{brandError}</div>}
      {brandSaveOpen && (
        <div className="brand-save-form">
          <label className="label">Brand name</label>
          <input
            className="input"
            placeholder="e.g. Acme Dental"
            value={brandSaveName}
            onChange={(e) => setBrandSaveName(e.target.value)}
          />
          <p className="hint">Saves the current Brand context fields for one-click reuse on future pages.</p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={brandSaveShared}
              onChange={(e) => setBrandSaveShared(e.target.checked)}
            />
            <span>Share across all my sites <span className="toggle-hint">usable on every site you connect</span></span>
          </label>
          <div className="comp-form-actions">
            <button
              type="button"
              className="primary"
              disabled={brandSaveBusy || !brandSaveName.trim()}
              onClick={handleSaveBrand}
            >
              {brandSaveBusy ? 'Saving…' : 'Save brand'}
            </button>
            <button type="button" className="ghost small" onClick={() => setBrandSaveOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {brandManageOpen && myBrands.length > 0 && (
        <ul className="brand-manage">
          {myBrands.map((b) => (
            <li key={b.id}>
              <span className="name">{b.name}</span>
              {b.scope === 'all' && <span className="shared-badge">shared</span>}
              <button
                type="button"
                className="ghost small"
                title="Edit this saved brand"
                disabled={brandBusy || brandEditBusy}
                onClick={() => (String(brandEditId) === String(b.id) ? setBrandEditId(null) : openBrandEdit(b))}
              >
                ✎ Edit
              </button>
              <button
                type="button"
                className="brand-x"
                title="Delete this saved brand"
                disabled={brandBusy}
                onClick={() => handleDeleteBrand(b.id)}
              >
                ✕
              </button>
              {String(brandEditId) === String(b.id) && (
                <div className="brand-edit-form">
                  <label className="label">Brand name</label>
                  <input
                    className="input"
                    value={brandEditName}
                    onChange={(e) => setBrandEditName(e.target.value)}
                  />
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={brandEditUpdateCtx}
                      onChange={(e) => setBrandEditUpdateCtx(e.target.checked)}
                    />
                    <span>
                      Update context from current brand fields
                      <span className="toggle-hint">re-captures the Brand context panel above</span>
                    </span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={brandEditShared}
                      onChange={(e) => setBrandEditShared(e.target.checked)}
                    />
                    <span>Shared across all my sites</span>
                  </label>
                  <div className="comp-form-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={brandEditBusy || !brandEditName.trim()}
                      onClick={handleUpdateBrand}
                    >
                      {brandEditBusy ? 'Saving…' : 'Update brand'}
                    </button>
                    <button type="button" className="ghost small" onClick={() => setBrandEditId(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid2">
        <div>
          <label className="label">Widget mode</label>
          <div className="seg">
            <button
              type="button"
              className={!allowPro ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setAllowPro(false)}
            >
              Free
            </button>
            <button
              type="button"
              className={allowPro ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setAllowPro(true)}
              disabled={!elementorPro}
              title={elementorPro ? '' : 'Elementor Pro not detected on this site'}
            >
              Free + Pro
            </button>
          </div>
        </div>
        <div>
          {/* Image source */}
          <label className="label">Images</label>
          <select className="input" value={imageMode === 'unsplash' ? 'auto' : imageMode} onChange={(e) => setImageMode(e.target.value)}>
            <option value="auto">Auto — model picks stock URLs</option>
            <option value="gemini">AI-generated (Gemini){geminiKey ? '' : ' — needs key from Connect'}</option>
          </select>
        </div>
      </div>
      {imageMode === 'gemini' && !geminiKey && (
        <p className="hint">Add a Gemini API key on the Connect screen to enable AI image generation.</p>
      )}

      {/* Header handling */}
      <label className="label">Header</label>
      <select className="input" value={includeHeader} onChange={(e) => setIncludeHeader(e.target.value)}>
        <option value="none">No header — my site already has one</option>
        <option value="full">Full header (real nav menu)</option>
      </select>
      <p className="hint">Most WordPress themes already provide the site header.</p>

      <label className="toggle">
        <input type="checkbox" checked={autoRefine} onChange={(e) => setAutoRefine(e.target.checked)} />
        <span>Auto-refine <span className="toggle-hint">extra quality pass — slower, higher polish</span></span>
      </label>

      {/* Structured brand context */}
      <button type="button" className="ghost small brand-toggle" onClick={() => setBrandOpen((v) => !v)}>
        {brandOpen ? '▾' : '▸'} Brand context {brandTokenEstimate > 0 ? `(~${brandTokenEstimate} tokens)` : '(optional)'}
      </button>
      {brandOpen && (
        <div className="brand-panel">
          {[
            ['businessIdentity', 'Business identity', 'What the business is and does'],
            ['audience', 'Primary audience', 'Who it is for'],
            ['voice', 'Brand & voice/tone', 'How it should sound'],
            ['contentSeoRules', 'Content & SEO rules', 'Keywords, phrasing, claims to make/avoid'],
            ['technicalConstraints', 'Technical constraints', 'e.g. keep copy short; avoid dark backgrounds'],
            ['doNot', 'Do NOT', 'What to avoid'],
          ].map(([key, label, ph]) => (
            <div key={key}>
              <label className="label">{label}</label>
              <input
                className="input"
                placeholder={ph}
                value={brand[key]}
                onChange={(e) => setBrand((b) => ({ ...b, [key]: e.target.value }))}
              />
            </div>
          ))}
          <p className="hint">Sent as guardrails Claude follows on every generation (~{brandTokenEstimate} tokens).</p>
        </div>
      )}

      {/* Component library (saved sections, reusable in new pages) */}
      <button type="button" className="ghost small brand-toggle" onClick={toggleComponentsPanel}>
        {componentsOpen ? '▾' : '▸'} Component library
        {selectedComponentIds.length > 0
          ? ` (${selectedComponentIds.length} selected)`
          : components.length > 0 ? ` (${components.length})` : ''}
      </button>
      {componentsOpen && (
        <div className="library-panel">
          {componentsLoading && <p className="hint">Loading components…</p>}
          {componentsError && (
            <div className="alert-error alert-row">
              <span>{componentsError}</span>
              <button type="button" className="ghost small" onClick={loadComponents} disabled={componentsLoading}>
                Try again
              </button>
            </div>
          )}
          {!componentsLoading && !componentsError && components.length === 0 && (
            <p className="hint">Save sections you like from any result, reuse them in new pages.</p>
          )}
          <div className="alert-row" style={{ marginBottom: 8 }}>
            <button
              type="button"
              className="ghost small"
              onClick={handleSuggestComponents}
              disabled={compSuggestBusy || !prompt.trim()}
              title={!prompt.trim() ? 'Write the brief first' : 'AI picks which saved blocks fit this brief'}
            >
              {compSuggestBusy ? 'Matching…' : '✨ Suggest for this brief'}
            </button>
            {compSuggestEmpty && <span className="hint">No saved components fit this brief.</span>}
          </div>
          {compSuggestError && <div className="alert-error">{compSuggestError}</div>}
          {components.map((c) => (
            <div key={c.id} className="lib-row">
              <label className="lib-pick">
                <input
                  type="checkbox"
                  checked={selectedComponentIds.includes(String(c.id))}
                  onChange={() => toggleComponentSelected(c.id)}
                />
                <span className="lib-name">{c.name}</span>
                <span className="lib-type">{c.type || 'other'}</span>
              </label>
              {gw && gw.available && (
                <button
                  type="button"
                  className="ghost small"
                  title="Create an Elementor Global Widget from this block (single-widget blocks only)"
                  disabled={gwCreateBusyId === c.id}
                  onClick={() => handleMakeGlobalWidget(c)}
                >
                  {gwCreateBusyId === c.id ? '…' : '→ Global widget'}
                </button>
              )}
              <button
                type="button"
                className="brand-x"
                title="Delete this component"
                disabled={libBusy}
                onClick={() => handleDeleteComponent(c.id)}
              >
                ✕
              </button>
              {compPicks[String(c.id)] && (
                <span className="hint lib-reason">AI: {compPicks[String(c.id)]}</span>
              )}
            </div>
          ))}
          {selectedComponentIds.length > 0 && (
            <p className="hint">
              {selectedComponentIds.length} component{selectedComponentIds.length > 1 ? 's' : ''} will be reused in the next generation.
            </p>
          )}
        </div>
      )}

      {/* Site global widgets (Elementor Pro — auto-sync everywhere they're used) */}
      <button type="button" className="ghost small brand-toggle" onClick={toggleGwPanel}>
        {gwOpen ? '▾' : '▸'} Site global widgets
        {gw && gw.available && gw.widgets.length > 0 ? ` (${gw.widgets.length})` : ''}
      </button>
      {gwOpen && (
        <div className="library-panel">
          {gwBusy && <p className="hint">Loading global widgets…</p>}
          {gwError && <div className="alert-error">{gwError}</div>}
          {gwNotice && <p className="hint">✓ {gwNotice}</p>}
          {!gwBusy && gw && !gw.available && (
            <p className="hint">{gw.message || 'Global widgets require Elementor Pro and plugin v1.3.0+.'}</p>
          )}
          {!gwBusy && gw && gw.available && (
            <>
              <label className="toggle">
                <input type="checkbox" checked={useGW} onChange={(e) => setUseGW(e.target.checked)} />
                <span>Let the AI use these global widgets <span className="toggle-hint">they auto-sync across every page that uses them</span></span>
              </label>
              {gw.widgets.length === 0 && (
                <p className="hint">No global widgets on this site yet — convert a saved component with “→ Global widget”.</p>
              )}
              {gw.widgets.map((w) => (
                <div key={w.id} className="lib-row">
                  <span className="lib-name">{w.title}</span>
                  <span className="lib-type">#{w.id}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {mode === 'new' && (
        <>
          <label className="label">Page title (optional)</label>
          {multiPage ? (
            <p className="hint">
              Multi-page mode is on — each page is titled by its own name in the
              <b> Pages to build</b> list on the left. This field is not used.
            </p>
          ) : (
            <input className="input" placeholder="Left blank = AI decides" value={title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </>
      )}

      {/* Design variations (near Generate; unavailable in multi-page mode) */}
      {mode === 'new' && (
        <>
          <label className="label">Variations</label>
          <select
            className="input"
            value={variations}
            disabled={multiPage}
            title={multiPage ? 'Not available in multi-page mode' : ''}
            onChange={(e) => setVariations(Number(e.target.value))}
          >
            <option value={1}>1 — single design</option>
            <option value={2}>2 designs to compare</option>
            <option value={3}>3 designs to compare</option>
          </select>
          {multiPage && <p className="hint">Variations are unavailable in multi-page mode.</p>}
          {!multiPage && variations > 1 && (
            <p className="hint">All variations publish as drafts — compare them, then pick a winner in WordPress.</p>
          )}
        </>
      )}

      </div>
      </div>
      <button className="primary" onClick={handleGenerate} disabled={!canGenerate}>
        {generateLabel}
      </button>

      {/* Progress stepper (single generate flow; batches render theirs inline, refine inside its panel) */}
      {running && !result && !batch && <Stepper stage={stage} detail={stageDetail} withRefine={autoRefine} />}

      {/* Error */}
      {error && (
        <div className="alert-error">
          {error.message}
          {error.rawOutput && (
            <button className="ghost small" onClick={() => {
              const blob = new Blob([error.rawOutput], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = 'raw-output.txt'; a.click();
              URL.revokeObjectURL(url);
            }}>Download raw output</button>
          )}
        </div>
      )}

      {/* Single result */}
      {result && !batch && (
        <div className="result">
          <div className="result-head">✓ Page {result.status === 'publish' ? 'published' : 'saved as draft'}</div>
          {result.repairs && result.repairs.length > 0 && (
            <details className="repairs">
              <summary>{result.repairs.length} auto-fix(es) applied</summary>
              <ul>{result.repairs.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </details>
          )}
          <div className="result-actions">
            <a className="primary" href={result.pageUrl} target="_blank" rel="noreferrer">View page</a>
            <a className="secondary" href={result.editorUrl} target="_blank" rel="noreferrer">Edit in Elementor</a>
            <button className="secondary" onClick={() => handlePreview()} disabled={previewBusy}>
              {previewBusy ? 'Rendering…' : 'Preview'}
            </button>
            <button className="secondary" onClick={() => setRefineOpen((v) => !v)}>Refine</button>
            <button className="secondary" onClick={toggleSuggest} disabled={suggestBusy || !result.rawJson}>
              {suggestBusy ? 'Thinking…' : 'AI suggestions'}
            </button>
            <button className="secondary" onClick={toggleHistory} disabled={!result.pageId}>History</button>
            {renderUndoRedoCompare()}
            <button className="ghost" onClick={downloadJson}>Download JSON</button>
          </div>
          {undoNotice && <p className="hint">✓ {undoNotice}</p>}

          {renderProReport()}
          {renderSectionsPanel()}
          {renderSuggestPanel()}
          {renderHistoryPanel()}
          {renderRefinePanel()}
        </div>
      )}

      {/* Batch results (multi-page site / design variations) */}
      {batch && (
        <div className="result">
          <div className="result-head">
            {batch.kind === 'multi' ? 'Multi-page site'
              : batch.kind === 'bulk' ? 'Bulk redesign'
              : 'Design variations'} — {batchDone} of {batch.items.length} built
          </div>

          {running && batchProgress && (
            <>
              <div className="batch-progress">
                Building {batchProgress.index} of {batchProgress.total}: {batchProgress.name}
                {stageDetail && <span className="batch-progress-detail"> — {stageDetail}</span>}
              </div>
              <Stepper stage={stage} detail={stageDetail} withRefine={autoRefine} />
            </>
          )}

          <div className="batch-grid">
            {batch.items.map((it, i) => (
              <div
                key={i}
                className={[
                  'batch-card',
                  it.status,
                  (i === activeIdx && it.status === 'done') ? 'active' : '',
                ].join(' ').trim()}
                onClick={() => selectBatchItem(i)}
              >
                <div className="batch-card-head">
                  <span className="batch-card-title">{it.name}</span>
                  <span className={`batch-status ${it.status}`}>
                    {it.status === 'pending' ? 'Queued'
                      : it.status === 'running' ? 'Building…'
                      : it.status === 'error' ? 'Failed'
                      : (it.result && it.result.status === 'publish') ? 'Published' : 'Draft'}
                  </span>
                </div>
                {it.status === 'done' && it.result && (
                  <div className="batch-links">
                    <a href={it.result.pageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>View</a>
                    <a href={it.result.editorUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Edit in Elementor</a>
                    <button
                      className="ghost small"
                      disabled={previewBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectBatchItem(i);
                        handlePreview(it.result.rawJson);
                      }}
                    >
                      Preview
                    </button>
                  </div>
                )}
                {it.status === 'error' && (
                  <div className="batch-error">
                    <span>{(it.error && it.error.message) || 'Generation failed.'}</span>
                    <button
                      className="ghost small"
                      disabled={running}
                      onClick={(e) => { e.stopPropagation(); retryBatchItem(i, it); }}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {activeResult && (
            <>
              <p className="hint">
                Selected: <strong>{activeItem && activeItem.name}</strong> — Refine, History and Download apply to it. Click another card to switch.
                {batch.kind === 'variations' ? ' All variations are drafts; pick your favorite in WordPress.' : ''}
              </p>
              <div className="result-actions">
                <button className="secondary" onClick={() => setRefineOpen((v) => !v)}>Refine</button>
                <button className="secondary" onClick={toggleSuggest} disabled={suggestBusy || !activeResult.rawJson}>
                  {suggestBusy ? 'Thinking…' : 'AI suggestions'}
                </button>
                <button className="secondary" onClick={toggleHistory} disabled={!activeResult.pageId}>History</button>
                {renderUndoRedoCompare()}
                <button className="ghost" onClick={downloadJson}>Download JSON</button>
              </div>
              {undoNotice && <p className="hint">✓ {undoNotice}</p>}
              {renderProReport()}
              {renderSectionsPanel()}
              {renderSuggestPanel()}
              {renderHistoryPanel()}
              {renderRefinePanel()}
            </>
          )}
        </div>
      )}

      {/* Preview modal */}
      {previewHtml !== null && (
        <div className="modal-overlay" onClick={closePreview}>
          <div className="modal modal-preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                Page preview (approximation)
                {previewInteractive && (
                  <span className="preview-hint">Click any section to select it for refining.</span>
                )}
              </span>
              {previewDeviceBusy && <span className="preview-hint">Rendering {previewDevice}…</span>}
              <div className="device-toggle" role="group" aria-label="Preview device">
                {DEVICES.map(([key, label, width]) => (
                  <button
                    key={key}
                    type="button"
                    className={previewDevice === key ? 'device-btn active' : 'device-btn'}
                    title={`${width}px viewport — device-true render`}
                    onClick={() => handlePreviewDeviceChange(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button className="ghost small" onClick={closePreview}>Close</button>
            </div>
            {previewError && <div className="alert-error preview-error">{previewError}</div>}
            <div className="preview-body" ref={previewBodyRef}>
              <div
                className="preview-scale"
                style={{ width: Math.round(deviceWidth * previewScale) }}
              >
                {/* allow-scripts (no allow-same-origin): the interactive render's
                    click-to-select script posts back via window.parent.postMessage */}
                <iframe
                  className="preview-frame"
                  title="Page preview"
                  srcDoc={previewHtml}
                  sandbox="allow-scripts"
                  style={{
                    width: deviceWidth,
                    height: `${100 / previewScale}%`,
                    transform: `scale(${previewScale})`,
                    transformOrigin: 'top left',
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Side-by-side compare modal (variations / pages / versions) */}
      {compareOpen && (
        <div className="modal-overlay" onClick={() => setCompareOpen(false)}>
          <div className="modal modal-compare" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Compare side by side</span>
              <button className="ghost small" onClick={() => setCompareOpen(false)}>Close</button>
            </div>
            <div className="compare-grid">
              {['left', 'right'].map((side) => {
                const st = compareSides[side];
                return (
                  <div key={side} className="compare-pane">
                    <select
                      className="input"
                      value={compareSel[side]}
                      onChange={(e) => loadCompareSide(side, e.target.value)}
                      aria-label={`Compare ${side}`}
                    >
                      {compareOptions.map((o) => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                      ))}
                    </select>
                    {compareSideBatch(side) && compareSideBatch(side === 'left' ? 'right' : 'left') && (
                      <div
                        className="compare-transplant"
                        style={{ marginTop: 6, padding: '8px 10px', border: '1px dashed #4a5568', borderRadius: 8 }}
                      >
                        <p className="hint" style={{ margin: '0 0 6px', fontWeight: 600 }}>
                          Mix &amp; match: send a section from this page {side === 'left' ? '→' : '←'} to{' '}
                          {(compareSideBatch(side === 'left' ? 'right' : 'left') || {}).opt?.label || 'the other page'}
                        </p>
                        <select
                          className="input"
                          value={transplantSel[side]}
                          disabled={transplantBusy}
                          onChange={(e) => {
                            const id = e.target.value;
                            setTransplantSel((t) => ({ ...t, [side]: id }));
                            if (id) transplantSection(side, id);
                          }}
                          aria-label="Send a section to the other page"
                        >
                          <option value="">
                            {transplantBusy ? 'Sending section…' : 'Choose the section to send…'}
                          </option>
                          {compareSideSections(side).map((sec) => (
                            <option key={sec.id} value={sec.id}>{sec.label}</option>
                          ))}
                        </select>
                        <p className="hint" style={{ margin: '4px 0 0', opacity: 0.75 }}>
                          Same section exists there? It gets REPLACED with this version. Otherwise it is added.
                        </p>
                        {transplantMsg && transplantMsg.side === side && (
                          <p className="hint" style={{ margin: '4px 0 0', color: transplantMsg.ok ? '#3fae5a' : '#d9534f', fontWeight: 600 }}>
                            {transplantMsg.text}
                          </p>
                        )}
                      </div>
                    )}
                    <div className="compare-body" ref={side === 'left' ? comparePaneRef : null}>
                      {st.busy && <p className="hint compare-msg">Rendering preview…</p>}
                      {st.error && <div className="alert-error compare-msg">{st.error}</div>}
                      {!st.busy && !st.error && st.html != null && (
                        <div
                          className="preview-scale"
                          style={{ width: Math.round(desktopWidth * compareScale) }}
                        >
                          <iframe
                            className="preview-frame"
                            title={`Compare ${side}`}
                            srcDoc={st.html}
                            sandbox=""
                            style={{
                              width: desktopWidth,
                              height: `${100 / compareScale}%`,
                              transform: `scale(${compareScale})`,
                              transformOrigin: 'top left',
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
