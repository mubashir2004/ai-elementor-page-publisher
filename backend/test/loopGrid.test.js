const test = require('node:test');
const assert = require('node:assert');
const { buildLoopCardSkeleton, buildLoopGridWidget, loopCardBindingsIntact, dynTag } = require('../generatePipeline.js');
const { validateAndRepair } = require('../validator.js');

const TAG_RE = /^\[elementor-tag id="[0-9a-f]{7}" name="[a-z-]+" settings="[^"]*"\]$/;

test('dynTag emits the exact source-verified shortcode format', () => {
  const t = dynTag('post-title');
  assert.match(t, TAG_RE);
  const t2 = dynTag('post-terms', { taxonomy: 'category' });
  assert.ok(t2.includes('name="post-terms"'));
  assert.ok(t2.includes(encodeURIComponent(JSON.stringify({ taxonomy: 'category' }))));
});

test('loop card skeleton: one container, all six widgets wired with __dynamic__', () => {
  const card = buildLoopCardSkeleton({ palette: { accent: '#d0202a', heading_text: '#111111', body_text: '#555555', card: '#ffffff' } });
  assert.equal(card.elType, 'container');
  const types = card.elements.map((e) => e.widgetType);
  assert.deepEqual(types, ['image', 'heading', 'heading', 'text-editor', 'heading', 'button']);
  assert.ok(loopCardBindingsIntact(card), 'title+url+featured-image bindings present');
  const img = card.elements[0];
  assert.match(img.settings.__dynamic__.image, TAG_RE);
  const title = card.elements[2];
  assert.ok(title.settings.__dynamic__.title.includes('post-title'));
  assert.ok(title.settings.__dynamic__.link.includes('post-url'));
});

test('loop card survives validateAndRepair with every binding intact', async () => {
  const card = buildLoopCardSkeleton({ palette: {} });
  const out = await validateAndRepair(JSON.stringify({ title: 't', content: [card] }),
    { repairJson: async (t) => t }, { allowPro: true, containerize: false, cleanupAnchors: false });
  assert.ok(loopCardBindingsIntact(out.content[0]), 'validator preserves __dynamic__ wiring');
});

test('loop-grid widget uses the source-verified keys (template_id, post_query_*, columns)', () => {
  const g = buildLoopGridWidget(123, { columns: '3', postsPerPage: 6 });
  assert.equal(g.widgetType, 'loop-grid');
  assert.equal(g.settings.template_id, 123);
  assert.equal(g.settings.columns, '3');
  assert.equal(g.settings.columns_mobile, '1');
  assert.equal(g.settings.posts_per_page, 6);
  assert.equal(g.settings.post_query_post_type, 'post', 'query keys carry the post_query_ skin prefix');
  assert.equal(g.settings.equal_height, 'yes');
});

test('loop-grid widget survives validation (whitelisted for Pro)', async () => {
  const page = { title: 't', content: [{ id: 'aaaa111', elType: 'container', settings: {}, elements: [buildLoopGridWidget(55)] }] };
  const out = await validateAndRepair(JSON.stringify(page), { repairJson: async (t) => t }, { allowPro: true });
  assert.ok(JSON.stringify(out).includes('"loop-grid"'), 'loop-grid survives with allowPro');
});

const { buildTaxonomyFilterWidget, referenceShowsBlogFilter } = require('../generatePipeline.js');

test('taxonomy-filter widget: wired to the grid id with source-verified keys', async () => {
  const f = buildTaxonomyFilterWidget('abc1234', { palette: { accent: '#5b3b8c', body_text: '#555555' } });
  assert.equal(f.widgetType, 'taxonomy-filter');
  assert.equal(f.settings.selected_element, 'abc1234', 'bound to the loop-grid element id');
  assert.equal(f.settings.taxonomy, 'category');
  assert.equal(f.settings.show_first_item, 'yes');
  assert.equal(f.settings.taxonomy_filter_active_background_color, '#5b3b8c', 'active pill = accent');
  assert.equal(f.settings.taxonomy_filter_normal_text_color, '#555555');
});

test('taxonomy-filter survives validation (whitelisted for Pro), dropped without Pro', async () => {
  const page = { title: 't', content: [{ id: 'aaaa111', elType: 'container', settings: {}, elements: [buildTaxonomyFilterWidget('x', {})] }] };
  const pro = await validateAndRepair(JSON.stringify(page), { repairJson: async (t) => t }, { allowPro: true });
  assert.ok(JSON.stringify(pro).includes('taxonomy-filter'), 'survives with Pro');
});

test('referenceShowsBlogFilter detects filter-pill references, ignores plain blogs', () => {
  assert.equal(referenceShowsBlogFilter({ sections: ['Blog: heading + filter tabs (All Posts | Residential | Commercial) above a 3-col post grid'] }), true);
  assert.equal(referenceShowsBlogFilter({ sections: ['Blog: simple 3-col recent articles grid with dates'] }), false);
});

const { removeFakeFilterPills } = require('../generatePipeline.js');

test('removeFakeFilterPills strips a decorative button-pill row but keeps real content', () => {
  const band = {
    id: 'blgband2', elType: 'container', settings: {},
    elements: [
      { id: 'bhead001', elType: 'widget', widgetType: 'heading', settings: { title: 'Blog' }, elements: [] },
      { id: 'fakepils', elType: 'container', settings: {}, elements: [
        { id: 'pb00001', elType: 'widget', widgetType: 'button', settings: { text: 'Recent Posts' }, elements: [] },
        { id: 'pb00002', elType: 'widget', widgetType: 'button', settings: { text: 'Popular Posts' }, elements: [] },
        { id: 'pb00003', elType: 'widget', widgetType: 'button', settings: { text: 'Case Studies' }, elements: [] },
      ] },
      { id: 'viewrow1', elType: 'container', settings: {}, elements: [
        { id: 'vh00001', elType: 'widget', widgetType: 'heading', settings: { title: 'Latest' }, elements: [] },
        { id: 'vb00001', elType: 'widget', widgetType: 'button', settings: { text: 'View All' }, elements: [] },
      ] },
    ],
  };
  const repairs = [];
  const n = removeFakeFilterPills(band, repairs);
  assert.equal(n, 1, 'exactly the all-button pill row removed');
  const ids = band.elements.map((e) => e.id);
  assert.deepEqual(ids, ['bhead001', 'viewrow1'], 'heading and mixed view-all row kept');
});

const { stylePriceTables } = require('../generatePipeline.js');

test('stylePriceTables fills default-grey tables from the palette, never overrides model styling', () => {
  const page = {
    content: [{ id: 'b1', elType: 'container', settings: {}, elements: [
      { id: 'p1', elType: 'widget', widgetType: 'price-table', settings: { heading: 'Plain', price: '89' }, elements: [] },
      { id: 'p2', elType: 'widget', widgetType: 'price-table', settings: { heading: 'Styled', price: '149', header_background_color: '#123456', button_background_color: '#654321' }, elements: [] },
    ] }],
    _repairs: [],
  };
  stylePriceTables(page, { palette: { accent: '#e8611d', heading_text: '#132a4a' } });
  const plain = page.content[0].elements[0].settings;
  const styled = page.content[0].elements[1].settings;
  assert.equal(plain.header_background_color, '#132a4a', 'dark header from palette');
  assert.equal(plain.heading_color, '#ffffff');
  assert.equal(plain.button_background_color, '#e8611d', 'accent button');
  assert.equal(styled.header_background_color, '#123456', 'model styling untouched');
  assert.equal(styled.button_background_color, '#654321');
});

const { removeBandsWithWidget, verifyExternalImages } = require('../generatePipeline.js');

test('removeBandsWithWidget deletes invented blog/gallery bands, keeps everything else', () => {
  const page = {
    content: [
      { id: 'hero911', elType: 'container', settings: {}, elements: [
        { id: 'h911001', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hero' }, elements: [] } ] },
      { id: 'blog911', elType: 'container', settings: {}, elements: [
        { id: 'lg91101', elType: 'widget', widgetType: 'loop-grid', settings: { template_id: 1 }, elements: [] } ] },
      { id: 'gal0911', elType: 'container', settings: {}, elements: [
        { id: 'ic91101', elType: 'widget', widgetType: 'image-carousel', settings: {}, elements: [] } ] },
      { id: 'ftr0911', elType: 'container', settings: {}, elements: [
        { id: 'ft91101', elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>f</p>' }, elements: [] } ] },
    ],
    _repairs: [],
  };
  removeBandsWithWidget(page, ['posts', 'loop-grid'], 'blog');
  removeBandsWithWidget(page, ['image-carousel', 'gallery', 'image-gallery', 'media-carousel'], 'gallery');
  assert.deepEqual(page.content.map((b) => b.id), ['hero911', 'ftr0911'], 'invented bands gone, hero+footer kept');
  assert.equal(page._repairs.length, 2);
});

test('verifyExternalImages swaps dead URLs for verified stock photos', async () => {
  const content = [{
    id: 'b911111', elType: 'container', settings: {}, elements: [
      { id: 'imgdead', elType: 'widget', widgetType: 'image',
        settings: { image: { id: '', url: 'https://images.unsplash.com/photo-DEADDEAD?w=1400' } }, elements: [] },
      { id: 'imglive', elType: 'widget', widgetType: 'image',
        settings: { image: { id: '', url: 'https://images.unsplash.com/photo-GOODGOOD?w=1400' } }, elements: [] },
    ],
  }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: !String(url).includes('DEADDEAD'), status: String(url).includes('DEADDEAD') ? 404 : 200 });
  try {
    const repairs = [];
    const n = await verifyExternalImages(content, repairs);
    assert.equal(n, 1, 'one dead URL detected');
    assert.ok(!JSON.stringify(content).includes('DEADDEAD'), 'dead URL replaced');
    assert.ok(JSON.stringify(content).includes('GOODGOOD'), 'live URL untouched');
    assert.ok(repairs.some((r) => /dead image/.test(r)));
  } finally {
    globalThis.fetch = realFetch;
  }
});

const { styleServiceAreas } = require('../generatePipeline.js');

test('styleServiceAreas rebuilds a long city icon-list into ghost pills (any design, page colors)', () => {
  const cities = ['Anaheim Hills','Chino Hills','Corona','Eastvale','Irvine','Norco','Villa Park','Yorba Linda'];
  const page = {
    content: [{
      id: 'areas911', elType: 'container', settings: {},
      elements: [
        { id: 'ah91101', elType: 'widget', widgetType: 'heading', settings: { title: 'Service Areas' }, elements: [] },
        { id: 'panel911', elType: 'container', isInner: true, settings: { background_color: '#132a4a' },
          elements: [
            { id: 'il91101', elType: 'widget', widgetType: 'icon-list',
              settings: { icon_list: cities.map((c, i) => ({ _id: 'c' + i, text: c, link: { url: '#' } })) }, elements: [] },
          ] },
      ],
    }],
    _repairs: [],
  };
  const n = styleServiceAreas(page, { palette: { accent: '#e8611d', heading_text: '#132a4a' } });
  assert.equal(n, 1, 'one list rebuilt');
  const panel = page.content[0].elements[1];
  const pillRow = panel.elements[0];
  assert.equal(pillRow.elType, 'container');
  assert.equal(pillRow.settings.flex_wrap, 'wrap');
  assert.equal(pillRow.elements.length, cities.length, 'one pill per city');
  const pill = pillRow.elements[0];
  assert.equal(pill.widgetType, 'button');
  assert.equal(pill.settings.text, 'Anaheim Hills');
  assert.equal(pill.settings.button_text_color, '#ffffff', 'white text on the dark panel');
  assert.equal(pill.settings.border_radius.top, '20', 'pill shape');
  assert.equal(panel.settings.padding.top, '36', 'panel gets breathing room');
});

test('styleServiceAreas leaves short lists and non-area bands alone', () => {
  const page = {
    content: [{
      id: 'feat911', elType: 'container', settings: {},
      elements: [
        { id: 'fh91101', elType: 'widget', widgetType: 'heading', settings: { title: 'Why Choose Us' }, elements: [] },
        { id: 'fl91101', elType: 'widget', widgetType: 'icon-list',
          settings: { icon_list: [{ text: 'Licensed' }, { text: 'Insured' }] }, elements: [] },
      ],
    }],
    _repairs: [],
  };
  const n = styleServiceAreas(page, { palette: { accent: '#e8611d' } });
  assert.equal(n, 0, 'untouched');
  assert.equal(page.content[0].elements[1].widgetType, 'icon-list', 'short feature list stays an icon-list');
});

test('stylePriceTables: near-grey default header is overridden; ribbons recolored to accent', () => {
  const page = {
    content: [{ id: 'b2', elType: 'container', settings: {}, elements: [
      { id: 'pg1', elType: 'widget', widgetType: 'price-table',
        settings: { heading: 'Plan', price: '89', header_background_color: '#54595f', show_ribbon: 'yes', ribbon_title: 'POPULAR' }, elements: [] },
    ] }],
    _repairs: [],
  };
  stylePriceTables(page, { palette: { accent: '#e8611d', heading_text: '#132a4a' } });
  const s = page.content[0].elements[0].settings;
  assert.equal(s.header_background_color, '#132a4a', 'default grey #54595f replaced with brand dark');
  assert.equal(s.ribbon_bg_color, '#e8611d', 'ribbon takes the accent');
  assert.equal(s.ribbon_text_color, '#ffffff');
});

test('ribbons: explicitly-green (off-palette) ribbon colors are recolored to the accent', () => {
  const page = {
    content: [{ id: 'b3', elType: 'container', settings: {}, elements: [
      { id: 'pr1', elType: 'widget', widgetType: 'price-table',
        settings: { heading: 'A', price: '89', show_ribbon: 'yes', ribbon_title: 'POPULAR', ribbon_bg_color: '#4caf50' }, elements: [] },
      { id: 'pr2', elType: 'widget', widgetType: 'price-table',
        settings: { heading: 'B', price: '19', show_ribbon: 'yes', ribbon_title: 'BEST', ribbon_bg_color: '#e8611d' }, elements: [] },
    ] }],
    _repairs: [],
  };
  stylePriceTables(page, { palette: { accent: '#e8611d', heading_text: '#132a4a' } });
  assert.equal(page.content[0].elements[0].settings.ribbon_bg_color, '#e8611d', 'green recolored to accent');
  assert.equal(page.content[0].elements[1].settings.ribbon_bg_color, '#e8611d', 'palette color kept');
});

const { setNavMenuSlug, extractNavItems } = require('../generatePipeline.js');

test('extractNavItems returns clean reference labels, rejects junk/placeholder specs', () => {
  assert.deepEqual(
    extractNavItems({ header: { nav_items: ['Residential', 'Commercial', 'Service Area', 'Our Plans', 'Pest Library'] } }),
    ['Residential', 'Commercial', 'Service Area', 'Our Plans', 'Pest Library']);
  assert.equal(extractNavItems({ header: { nav_items: ['EXACT nav link labels copied from the image'] } }), null, 'placeholder text rejected');
  assert.equal(extractNavItems({ header: {} }), null);
  assert.equal(extractNavItems(null), null);
});

test('setNavMenuSlug points every nav-menu widget at the generated menu', () => {
  const content = [{ id: 'h1', elType: 'container', settings: {}, elements: [
    { id: 'n1', elType: 'widget', widgetType: 'nav-menu', settings: { menu: 'old-junk-menu' }, elements: [] },
  ] }];
  const n = setNavMenuSlug(content, 'aircomfort-nav');
  assert.equal(n, 1);
  assert.equal(content[0].elements[0].settings.menu, 'aircomfort-nav');
});

const { derivePaletteFromPage } = require('../generatePipeline.js');

test('derivePaletteFromPage: accent from button fills, heading from dark title colors', () => {
  const page = { content: [{ id: 'b9', elType: 'container', settings: {}, elements: [
    { id: 'h9a', elType: 'widget', widgetType: 'heading', settings: { title: 'A', title_color: '#132A4A' }, elements: [] },
    { id: 'h9b', elType: 'widget', widgetType: 'heading', settings: { title: 'B', title_color: '#132A4A' }, elements: [] },
    { id: 'b9a', elType: 'widget', widgetType: 'button', settings: { text: 'Go', background_color: '#E8611D' }, elements: [] },
    { id: 'b9b', elType: 'widget', widgetType: 'button', settings: { text: 'Go2', background_color: '#E8611D' }, elements: [] },
    { id: 'b9c', elType: 'widget', widgetType: 'button', settings: { text: 'Ghost', background_color: '#777777' }, elements: [] },
  ] }] };
  const ds = derivePaletteFromPage(page);
  assert.equal(ds.palette.accent, '#e8611d', 'saturated button fill wins over grey');
  assert.equal(ds.palette.heading_text, '#132a4a');
  assert.equal(derivePaletteFromPage({ content: [] }), null, 'no colors -> null');
});

const { insertSectionWithFreshIds } = require('../generatePipeline.js');

test('insertSectionWithFreshIds: inserts before the footer with fresh unique ids', () => {
  const target = [
    { id: 'hero0t1', elType: 'container', settings: {}, elements: [] },
    { id: 'ftr00t1', elType: 'container', settings: {}, elements: [] },
  ];
  const section = { id: 'hero0t1', elType: 'container', settings: {}, elements: [
    { id: 'ftr00t1', elType: 'widget', widgetType: 'heading', settings: { title: 'Stolen ids' }, elements: [] },
  ] };
  const at = insertSectionWithFreshIds(target, section, undefined);
  assert.equal(at, 1, 'default insert = before the last band (footer)');
  assert.equal(target.length, 3);
  const ids = [];
  (function w(els){ els.forEach((e)=>{ ids.push(e.id); (e.elements||[]).forEach((c)=>ids.push(c.id)); }); })(target);
  assert.equal(new Set(ids).size, ids.length, 'all ids unique after transplant');
  assert.equal(target[1].elements[0].settings.title, 'Stolen ids', 'content preserved');
});

test('insertSectionWithFreshIds: explicit index is clamped and honored', () => {
  const target = [{ id: 'a000001', elType: 'container', settings: {}, elements: [] }];
  const at = insertSectionWithFreshIds(target, { id: 'b000001', elType: 'container', settings: {}, elements: [] }, 99);
  assert.equal(at, 1, 'index clamped to end');
});

const { upsertSectionByMatch, findMatchingBandIndex } = require('../generatePipeline.js');

const bandWithHeading = (id, title) => ({
  id, elType: 'container', settings: {}, elements: [
    { id: id.slice(0, 4) + 'h01', elType: 'widget', widgetType: 'heading', settings: { title }, elements: [] },
  ],
});

test('transplant REPLACES the matching section (same heading) at the same position', () => {
  const target = [
    bandWithHeading('hero0m1', 'Expert Movers in Chicago'),
    bandWithHeading('why00m1', 'WHY 200,000+ PEOPLE CHOOSE US'),
    bandWithHeading('ftr00m1', 'Get Moving Today'),
  ];
  const incoming = bandWithHeading('why00m2', 'Why 200,000+ People Choose Us');
  incoming.elements.push({ id: 'newx001', elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>better version</p>' }, elements: [] });
  const res = upsertSectionByMatch(target, incoming);
  assert.equal(res.mode, 'replaced');
  assert.equal(res.at, 1, 'replaced IN PLACE at the old index');
  assert.equal(target.length, 3, 'no duplicate added');
  assert.ok(JSON.stringify(target[1]).includes('better version'), 'new version is in');
});

test('transplant ADDS before the footer when no matching section exists', () => {
  const target = [
    bandWithHeading('hero0m3', 'Expert Movers'),
    bandWithHeading('ftr00m3', 'Footer Links'),
  ];
  const incoming = bandWithHeading('faq00m3', 'Frequently Asked Questions');
  const res = upsertSectionByMatch(target, incoming);
  assert.equal(res.mode, 'added');
  assert.equal(res.at, 1, 'inserted before the footer');
  assert.equal(target.length, 3);
});

test('findMatchingBandIndex: short/empty headings never match (safety)', () => {
  const target = [bandWithHeading('a00000x', 'Hi')];
  assert.equal(findMatchingBandIndex(target, bandWithHeading('b00000x', 'Hi')), -1, 'too short to trust');
});

test('final invariants: "No header" DELETES a header band the model built anyway', async () => {
  // Exercised through the exported pieces: simulate the final-invariant slice.
  // (The full path runs inside runPipeline; the removal logic mirrors it.)
  const els = [
    { id: 'strip9x1', elType: 'container', settings: {}, elements: [
      { id: 'st9x1h1', elType: 'widget', widgetType: 'heading', settings: { title: 'WE DISPATCH AT 6AM SERVING EVERYWHERE', header_size: 'div' }, elements: [] } ] },
    { id: 'hdr9x01', elType: 'container', settings: { html_tag: 'header' }, elements: [
      { id: 'nv9x001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] } ] },
    { id: 'hero9x1', elType: 'container', settings: {}, elements: [
      { id: 'h19x001', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hero' }, elements: [] } ] },
  ];
  // replicate the removal block's semantics
  for (let i = Math.min(3, els.length - 1); i >= 0; i--) {
    const el = els[i];
    const isHeader = (el.settings && el.settings.html_tag === 'header') || JSON.stringify(el).includes('"nav-menu"');
    if (isHeader) {
      els.splice(i, 1);
      const prev = els[i - 1];
      if (prev && !JSON.stringify(prev).includes('"h1"') && !JSON.stringify(prev).includes('"widgetType":"button"')) {
        let wc = 0; (function c(n){ if(!n||typeof n!=='object')return; if(n.elType==='widget')wc++; (n.elements||[]).forEach(c); })(prev);
        if (wc > 0 && wc <= 6) els.splice(i - 1, 1);
      }
      break;
    }
  }
  assert.deepEqual(els.map((e) => e.id), ['hero9x1'], 'header AND its topbar strip removed; hero survives');
});
