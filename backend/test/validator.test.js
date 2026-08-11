/**
 * ============================================================
 * FILE: backend/test/validator.test.js
 * OWNER: Person 6
 * Run:  cd backend && node --test
 * ============================================================
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAndRepair } = require('../validator');
const { createMockClaude, samplePage } = require('./mockClaude');

const claude = createMockClaude();

test('valid JSON passes and keeps well-formed ids', async () => {
  const page = samplePage('Keep Me');
  const raw = JSON.stringify(page);
  const out = await validateAndRepair(raw, claude);
  assert.equal(out.title, 'Keep Me');
  assert.equal(out.content[0].id, 'sec0001'); // valid 7-char id preserved
  assert.equal(out.content[0].elType, 'section');
});

test('strips ```json fences before parsing', async () => {
  const raw = '```json\n' + JSON.stringify(samplePage()) + '\n```';
  const out = await validateAndRepair(raw, claude);
  assert.ok(Array.isArray(out.content) && out.content.length === 1);
});

test('repairs broken JSON via the (mock) model', async () => {
  const raw = '{ this is not json at all';
  const out = await validateAndRepair(raw, claude);
  assert.equal(out.title, 'Repaired'); // mock repairJson returns a valid page
});

test('regenerates duplicate ids', async () => {
  const page = samplePage();
  // Force a duplicate id between the section and a widget.
  page.content[0].elements[0].elements[1].id = 'sec0001';
  const out = await validateAndRepair(JSON.stringify(page), claude);
  const ids = [];
  (function walk(els) { els.forEach((e) => { ids.push(e.id); if (e.elements) walk(e.elements); }); })(out.content);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, 'all ids must be unique after repair');
});

test('drops a disallowed html widget', async () => {
  const page = samplePage();
  page.content[0].elements[0].elements.push({
    id: 'bad0001', elType: 'widget', widgetType: 'html',
    settings: { html: '<script>alert(1)</script>' }, elements: [],
  });
  const out = await validateAndRepair(JSON.stringify(page), claude);
  const hasHtml = JSON.stringify(out).includes('"widgetType":"html"');
  assert.equal(hasHtml, false, 'html widget must be removed');
});

test('drops a Pro form widget', async () => {
  const page = samplePage();
  page.content[0].elements[0].elements.push({
    id: 'frm0001', elType: 'widget', widgetType: 'form',
    settings: {}, elements: [],
  });
  const out = await validateAndRepair(JSON.stringify(page), claude);
  assert.equal(JSON.stringify(out).includes('"widgetType":"form"'), false);
});

test('keeps a Pro form widget when allowPro is true', async () => {
  const page = samplePage();
  page.content[0].elements[0].elements.push({
    id: 'frm0002', elType: 'widget', widgetType: 'form',
    settings: {}, elements: [],
  });
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  assert.equal(JSON.stringify(out).includes('"widgetType":"form"'), true,
    'form widget must survive when allowPro is true');
});

test('drops a Pro form widget when allowPro is false (default)', async () => {
  const page = samplePage();
  page.content[0].elements[0].elements.push({
    id: 'frm0003', elType: 'widget', widgetType: 'form',
    settings: {}, elements: [],
  });
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: false });
  assert.equal(JSON.stringify(out).includes('"widgetType":"form"'), false,
    'form widget must be dropped when allowPro is false');
});

test('drops an html widget even when allowPro is true', async () => {
  const page = samplePage();
  page.content[0].elements[0].elements.push({
    id: 'htm0001', elType: 'widget', widgetType: 'html',
    settings: { html: '<script>alert(1)</script>' }, elements: [],
  });
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  assert.equal(JSON.stringify(out).includes('"widgetType":"html"'), false,
    'html widget must never survive, even with allowPro');
});

test('normalizes a string image URL into an object', async () => {
  const page = samplePage();
  page.content[0].elements[0].elements[2].settings.image =
    'https://images.unsplash.com/photo-1_test?w=800';
  const out = await validateAndRepair(JSON.stringify(page), claude);
  const img = out.content[0].elements[0].elements[2].settings.image;
  assert.equal(typeof img, 'object');
  assert.equal(img.source, 'library');
  assert.ok('id' in img);
});

test('throws on empty content', async () => {
  const raw = JSON.stringify({ title: 'x', content: [] });
  await assert.rejects(() => validateAndRepair(raw, claude), /empty content/i);
});

test('rejects an oversized payload', async () => {
  const page = samplePage();
  // Bloat a text field past 3MB.
  page.content[0].elements[0].elements[1].settings.title = 'x'.repeat(3 * 1024 * 1024 + 10);
  await assert.rejects(() => validateAndRepair(JSON.stringify(page), claude), /too large/i);
});

test('sanitizes dangerous custom_css', async () => {
  const page = samplePage();
  page.custom_css = 'a{color:red} @import url(evil); .x{background:expression(alert(1))}</style><script>x</script>';
  const out = await validateAndRepair(JSON.stringify(page), claude);
  assert.equal(out.custom_css.includes('@import'), false);
  assert.equal(out.custom_css.toLowerCase().includes('<script'), false);
  assert.equal(out.custom_css.toLowerCase().includes('expression('), false);
});

test('containerize: section + 2 columns becomes a container with 2 child containers', async () => {
  const page = {
    title: 'Legacy Layout',
    page_settings: { hide_title: 'yes' },
    content: [{
      id: 'sec0001', elType: 'section', isInner: false,
      settings: {
        background_background: 'classic', background_color: '#101418',
        gap: 'no', layout: 'full_width',
        padding: { unit: 'px', top: '80', right: '0', bottom: '80', left: '0' },
      },
      elements: [
        {
          id: 'col0001', elType: 'column', isInner: false,
          settings: { _column_size: 60, _inline_size: null, content_position: 'center', background_color: '#ffffff' },
          elements: [{ id: 'hed0001', elType: 'widget', widgetType: 'heading', settings: { title: 'Hi' }, elements: [] }],
        },
        {
          id: 'col0002', elType: 'column', isInner: false,
          settings: { _column_size: 40, _inline_size: null },
          elements: [{ id: 'txt0001', elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>x</p>' }, elements: [] }],
        },
      ],
    }],
    custom_css: '',
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { containerize: true });
  const root = out.content[0];

  // Section -> container with the flex row defaults. Base flex_wrap is GONE
  // (it made ~100%-sum rows wrap on desktop); wrapping is mobile-only now.
  assert.equal(root.elType, 'container');
  assert.equal(root.isInner, false);
  assert.equal(root.settings.flex_direction, 'row');
  assert.equal(root.settings.flex_wrap, undefined);
  assert.equal(root.settings.flex_wrap_mobile, 'wrap');
  assert.equal(root.settings.content_width, 'full');       // layout:'full_width'
  assert.equal(root.settings.flex_gap.column, '0');        // gap:'no' -> 0
  assert.equal(root.settings.flex_gap.unit, 'px');
  assert.equal(root.settings.background_color, '#101418'); // background kept
  assert.equal(root.settings.padding.top, '80');           // padding kept
  assert.equal(root.settings.layout, undefined);
  assert.equal(root.settings.gap, undefined);

  // Columns -> child containers with widths fitted for desktop (scaled to
  // 96.5% of the row so they fit WITH gaps) and mobile stacking.
  assert.equal(root.elements.length, 2);
  const [c1, c2] = root.elements;
  for (const c of [c1, c2]) {
    assert.equal(c.elType, 'container');
    assert.equal(c.isInner, true);
    assert.equal(c.settings.content_width, 'full');
    assert.equal(c.settings.flex_direction, 'column');
    assert.equal(c.settings.width_mobile.size, 100);
    assert.equal(c.settings._column_size, undefined);
    assert.equal(c.settings._inline_size, undefined);
  }
  assert.equal(c1.settings.width.size, 57.9); // 60 * 96.5 / 100
  assert.equal(c2.settings.width.size, 38.6); // 40 * 96.5 / 100
  assert.ok(out._repairs.some((r) => /Normalized 1 row container/.test(r)));
  assert.equal(c1.settings.flex_justify_content, 'center'); // content_position:'center'
  assert.equal(c1.settings.background_color, '#ffffff');    // column background kept

  // Widgets untouched.
  assert.equal(c1.elements[0].widgetType, 'heading');
  assert.equal(c1.elements[0].settings.title, 'Hi');
  assert.equal(c2.elements[0].widgetType, 'text-editor');

  // A containerize repair note was recorded.
  assert.ok(out._repairs.some((r) => /containerized/i.test(r)));
});

test('mobile safety net: sized child containers get width_mobile, rows wrap on MOBILE only (one note per page)', async () => {
  const page = {
    title: 'Containers',
    content: [{
      id: 'con0001', elType: 'container', isInner: false,
      settings: { flex_direction: 'row' },
      elements: [
        {
          id: 'con0002', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'hed0002', elType: 'widget', widgetType: 'heading', settings: { title: 'a' }, elements: [] }],
        },
        {
          id: 'con0003', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'hed0003', elType: 'widget', widgetType: 'heading', settings: { title: 'b' }, elements: [] }],
        },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const root = out.content[0];
  // The desktop-wrap bug fix: NO base flex_wrap (the 2x50% row must stay one
  // row on desktop); wrap moves to mobile where children stack anyway.
  assert.equal(root.settings.flex_wrap, undefined, 'no base flex_wrap on a single-row container');
  assert.equal(root.settings.flex_wrap_mobile, 'wrap', 'row container wraps on mobile');
  for (const child of root.elements) {
    assert.equal(child.settings.width.size, 48.3, 'width fitted to 96.5% of the row (50 * 96.5 / 100)');
    assert.equal(child.settings.width_mobile.size, 100, 'sized child stacks to 100% on mobile');
    assert.equal(child.settings.width_mobile.unit, '%');
  }
  // Repair notes are deduped: one per page, not one per element.
  assert.equal(out._repairs.filter((r) => /width_mobile/.test(r)).length, 1);
  assert.equal(out._repairs.filter((r) => /flex_wrap_mobile/.test(r)).length, 1);
  assert.equal(out._repairs.filter((r) => /Normalized 1 row container/.test(r)).length, 1);
});

test('row normalizer: model-authored base flex_wrap on a ~100% row moves to mobile and widths are fitted', async () => {
  const page = {
    title: 'Desktop Wrap Bug',
    content: [{
      id: 'row0001', elType: 'container', isInner: false,
      settings: {
        flex_direction: 'row',
        flex_wrap: 'wrap', // the bug: base wrap + 50/50 widths + gap wraps on DESKTOP
        flex_gap: { column: '20', row: '20', isLinked: true, unit: 'px' },
      },
      elements: [
        {
          id: 'chl0001', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'hed0011', elType: 'widget', widgetType: 'heading', settings: { title: 'left' }, elements: [] }],
        },
        {
          id: 'chl0002', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'hed0012', elType: 'widget', widgetType: 'heading', settings: { title: 'right' }, elements: [] }],
        },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const root = out.content[0];
  assert.equal(root.settings.flex_wrap, undefined, 'base flex_wrap removed for single-row intent');
  assert.equal(root.settings.flex_wrap_mobile, 'wrap', 'wrap moved to mobile');
  assert.equal(root.elements[0].settings.width.size, 48.3);
  assert.equal(root.elements[1].settings.width.size, 48.3);
  assert.equal(root.elements[0].settings.width_mobile.size, 100);
  assert.equal(root.elements[1].settings.width_mobile.size, 100);
  assert.ok(out._repairs.some((r) => /Normalized 1 row container/.test(r)));
});

test('row normalizer: a multi-row grid (widths summing > 106) keeps base flex_wrap and untouched widths', async () => {
  const cards = Array.from({ length: 6 }, (_, i) => ({
    id: `card00${i + 1}`, elType: 'container', isInner: true,
    settings: { width: { unit: '%', size: 31 } },
    elements: [{ id: `hedg00${i + 1}`, elType: 'widget', widgetType: 'heading', settings: { title: `card ${i + 1}` }, elements: [] }],
  }));
  const page = {
    title: 'Grid',
    content: [{
      id: 'grid001', elType: 'container', isInner: false,
      settings: { flex_direction: 'row', flex_wrap: 'wrap' },
      elements: cards,
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const root = out.content[0];
  assert.equal(root.settings.flex_wrap, 'wrap', 'grids MUST keep base flex_wrap (they wrap on desktop)');
  for (const child of root.elements) {
    assert.equal(child.settings.width.size, 31, 'grid widths are never rescaled');
    assert.equal(child.settings.width_mobile.size, 100, 'grid children still stack on mobile');
  }
  assert.ok(!out._repairs.some((r) => /Normalized \d+ row container/.test(r)),
    'grid must not count as a single-row normalization');
});

test('menu-anchor cleanup: ALL anchors are removed (never used)', async () => {
  const mkAnchor = (id, name) => ({
    id, elType: 'widget', widgetType: 'menu-anchor', settings: { anchor: name }, elements: [],
  });
  const mkContainer = (id, children) => ({
    id, elType: 'container', isInner: false, settings: {}, elements: children,
  });
  const page = {
    title: 'Anchors',
    content: [
      mkContainer('cona001', [
        mkAnchor('anca001', 'alpha'), // unreferenced -> removed
        { id: 'btn0001', elType: 'widget', widgetType: 'button', settings: { text: 'Go', link: { url: '#keepme' } }, elements: [] },
      ]),
      mkContainer('conb001', [mkAnchor('ancb001', 'beta')]),   // unreferenced -> removed
      mkContainer('conc001', [
        mkAnchor('ancc001', 'gamma'),                          // unreferenced -> removed
        mkAnchor('ancd001', 'keepme'),                         // referenced -> kept
      ]),
    ],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const anchors = [];
  (function walk(els) {
    els.forEach((e) => {
      if (e.widgetType === 'menu-anchor') anchors.push(e);
      if (Array.isArray(e.elements)) walk(e.elements);
    });
  })(out.content);

  assert.equal(anchors.length, 0, 'NO menu-anchor ever survives — referenced or not');
  assert.ok(out._repairs.some((r) => /menu-anchor/.test(r)), 'a repair note records the removal');
});

test('menu-anchor cleanup: duplicates are removed along with everything else', async () => {
  const page = {
    title: 'Dup Anchors',
    content: [{
      id: 'cond001', elType: 'container', isInner: false, settings: {},
      elements: [
        { id: 'anck001', elType: 'widget', widgetType: 'menu-anchor', settings: { anchor: 'twice' }, elements: [] },
        { id: 'anck002', elType: 'widget', widgetType: 'menu-anchor', settings: { anchor: 'twice' }, elements: [] },
        {
          id: 'icl0001', elType: 'widget', widgetType: 'icon-list',
          settings: { icon_list: [{ _id: 'li10001', text: 'Jump', link: { url: '#twice' } }] },
          elements: [],
        },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const anchors = [];
  (function walk(els) {
    els.forEach((e) => {
      if (e.widgetType === 'menu-anchor') anchors.push(e);
      if (Array.isArray(e.elements)) walk(e.elements);
    });
  })(out.content);

  assert.equal(anchors.length, 0, 'all anchors removed, duplicates included');
});

test('wraps a stray widget placed directly under a section into a column', async () => {
  const page = samplePage();
  page.content[0].elements.push({
    id: 'stray01', elType: 'widget', widgetType: 'heading',
    settings: { title: 'stray' }, elements: [],
  });
  const out = await validateAndRepair(JSON.stringify(page), claude);
  // Every direct child of a section must now be a column.
  out.content.forEach((sec) => sec.elements.forEach((child) => {
    assert.equal(child.elType, 'column');
  }));
});

test('header row: normalizer + safety net never stack it on mobile (nav-menu row)', async () => {
  const page = {
    title: 'Header stays one row',
    content: [{
      id: 'hdr0001', elType: 'container', isInner: false,
      settings: { flex_direction: 'row' },
      elements: [
        {
          id: 'hlogo01', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 20 } },
          elements: [{ id: 'himg001', elType: 'widget', widgetType: 'image', settings: { image: { id: '', url: 'https://images.unsplash.com/photo-1?w=200' } }, elements: [] }],
        },
        {
          id: 'hnav001', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 55 } },
          elements: [{ id: 'hnavw01', elType: 'widget', widgetType: 'nav-menu', settings: { menu: 'main' }, elements: [] }],
        },
        {
          id: 'hcta001', elType: 'container', isInner: true,
          settings: { width: { unit: '%', size: 25 } },
          elements: [{ id: 'hbtn001', elType: 'widget', widgetType: 'button', settings: { text: 'Call' }, elements: [] }],
        },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const row = out.content[0];
  assert.equal(row.settings.flex_wrap_mobile, 'nowrap', 'header row gets EXPLICIT nowrap on mobile (Elementor default wraps)');
  assert.equal(row.settings.flex_wrap, undefined, 'no base wrap');
  assert.equal(row.elements[0].settings.width_mobile.size, 20, 'children keep explicit side-by-side widths on mobile');
  assert.equal(row.elements[1].settings.width_mobile.size, 55);
  assert.equal(row.elements[2].settings.width_mobile.size, 25);
});

test('header wrapper (html_tag header): inner rows are skipped by the row normalizer too', async () => {
  const page = {
    title: 'Temp header',
    content: [{
      id: 'hwrap01', elType: 'container', isInner: false,
      settings: { html_tag: 'header' },
      elements: [{
        id: 'hrow001', elType: 'container', isInner: true,
        settings: { flex_direction: 'row' },
        elements: [
          { id: 'hcl0001', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
            elements: [{ id: 'hh10001', elType: 'widget', widgetType: 'heading', settings: { title: 'Logo' }, elements: [] }] },
          { id: 'hcl0002', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
            elements: [{ id: 'hbt0001', elType: 'widget', widgetType: 'button', settings: { text: 'Book' }, elements: [] }] },
        ],
      }],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const row = out.content[0].elements[0];
  assert.equal(row.settings.flex_wrap_mobile, 'nowrap', 'row inside html_tag:header gets explicit nowrap');
  assert.equal(row.elements[0].settings.width.size, 50, 'widths untouched inside header');
});

test('counter widgets get a clamped mobile number size (no phone overlap)', async () => {
  const page = {
    title: 'Stats',
    content: [{
      id: 'stats01', elType: 'container', isInner: false,
      settings: { flex_direction: 'row' },
      elements: [
        { id: 'stat001', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'cnt0001', elType: 'widget', widgetType: 'counter',
            settings: { ending_number: 1700, suffix: '+', title: 'Homes Cleaned', typography_number_typography: 'custom', typography_number_font_size: { unit: 'px', size: 80 } }, elements: [] }] },
        { id: 'stat002', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'cnt0002', elType: 'widget', widgetType: 'counter',
            settings: { ending_number: 40, suffix: '+', title: 'Trained Cleaners' }, elements: [] }] },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const c1 = out.content[0].elements[0].elements[0].settings;
  const c2 = out.content[0].elements[1].elements[0].settings;
  assert.equal(c1.typography_number_font_size_mobile.size, 44, '80px desktop clamps to 44px mobile');
  assert.equal(c2.typography_number_font_size_mobile.size, 40, 'no desktop size -> default 40px mobile');
  assert.equal(c2.typography_number_typography, 'custom', 'typography group enabled so the mobile size applies');
});

test('header with widgets DIRECTLY in the row (real generated shape): inline widths, visible CTA, nowrap', async () => {
  // Mirrors the exact structure the generator produced for page 21: one row
  // container with heading + nav-menu + button widgets as direct children.
  const page = {
    title: 'Real header shape',
    content: [{
      id: 'hdrw001', elType: 'container', isInner: false,
      settings: { content_width: 'full', flex_direction: 'row', flex_justify_content: 'space-between', flex_align_items: 'center', background_color: '#ffffff' },
      elements: [
        { id: 'wlogo01', elType: 'widget', widgetType: 'heading', settings: { title: 'Clens', header_size: 'div' }, elements: [] },
        { id: 'wnav001', elType: 'widget', widgetType: 'nav-menu', settings: { layout: 'horizontal' }, elements: [] },
        { id: 'wcta001', elType: 'widget', widgetType: 'button', settings: { text: 'Get a Quote', hide_mobile: 'hidden-phone' }, elements: [] },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const row = out.content[0];
  assert.equal(row.settings.flex_wrap_mobile, 'nowrap', 'explicit nowrap overrides Elementor mobile stacking');
  assert.equal(row.settings.flex_wrap_tablet, 'nowrap');
  const [logo, nav, cta] = row.elements;
  assert.equal(logo.settings._element_width, 'auto', 'header widgets become inline (full-width widgets stack)');
  assert.equal(nav.settings._element_width, 'auto');
  assert.equal(cta.settings._element_width, 'auto');
  assert.equal(cta.settings.hide_mobile, undefined, 'header CTA must stay VISIBLE on mobile');
});

test('counter clamp never ENLARGES: small px and non-px desktop sizes are left untouched', async () => {
  const page = {
    title: 'Small counters',
    content: [{
      id: 'stats02', elType: 'container', isInner: false,
      settings: { flex_direction: 'row' },
      elements: [
        { id: 'stat011', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'cnt0011', elType: 'widget', widgetType: 'counter',
            settings: { ending_number: 12, title: 'Years', typography_number_typography: 'custom', typography_number_font_size: { unit: 'px', size: 24 } }, elements: [] }] },
        { id: 'stat012', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
          elements: [{ id: 'cnt0012', elType: 'widget', widgetType: 'counter',
            settings: { ending_number: 5, title: 'Stars', typography_number_typography: 'custom', typography_number_font_size: { unit: 'rem', size: 1.5 } }, elements: [] }] },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const small = out.content[0].elements[0].elements[0].settings;
  const rem = out.content[0].elements[1].elements[0].settings;
  assert.equal(small.typography_number_font_size_mobile, undefined, '24px desktop is already phone-safe — no mobile override');
  assert.equal(rem.typography_number_font_size_mobile, undefined, 'rem sizes are left untouched (rendered px unknown)');
});

test('explicit flex_wrap_mobile:nowrap row (comparison table) keeps columns side by side on mobile', async () => {
  const page = {
    title: 'Comparison table',
    content: [{
      id: 'tbl0001', elType: 'container', isInner: false,
      settings: { flex_direction: 'row', flex_wrap_mobile: 'nowrap' },
      elements: [
        { id: 'tcol001', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 34 }, width_mobile: { unit: '%', size: 34 } },
          elements: [{ id: 'th00001', elType: 'widget', widgetType: 'heading', settings: { title: 'Us' }, elements: [] }] },
        { id: 'tcol002', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 33 }, width_mobile: { unit: '%', size: 33 } },
          elements: [{ id: 'th00002', elType: 'widget', widgetType: 'heading', settings: { title: 'Others' }, elements: [] }] },
        { id: 'tcol003', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 33 }, width_mobile: { unit: '%', size: 33 } },
          elements: [{ id: 'th00003', elType: 'widget', widgetType: 'heading', settings: { title: 'DIY' }, elements: [] }] },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const row = out.content[0];
  assert.equal(row.settings.flex_wrap_mobile, 'nowrap', 'explicit nowrap survives the safety net + normalizer');
  row.elements.forEach((c) => {
    assert.ok(Number(c.settings.width_mobile.size) < 100, 'table columns keep side-by-side mobile widths');
  });
});

test('footer nav-menu is NOT one-row forced (header scope = first matching band only)', async () => {
  const page = {
    title: 'Header + footer nav',
    content: [
      {
        id: 'hdrx001', elType: 'container', isInner: false,
        settings: { flex_direction: 'row' },
        elements: [
          { id: 'xlogo01', elType: 'widget', widgetType: 'heading', settings: { title: 'Logo', header_size: 'div' }, elements: [] },
          { id: 'xnav001', elType: 'widget', widgetType: 'nav-menu', settings: { layout: 'horizontal' }, elements: [] },
        ],
      },
      {
        id: 'ftr0001', elType: 'container', isInner: false,
        settings: { flex_direction: 'row' },
        elements: [
          { id: 'fcol001', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
            elements: [{ id: 'fh00001', elType: 'widget', widgetType: 'heading', settings: { title: 'About' }, elements: [] }] },
          { id: 'fcol002', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 50 } },
            elements: [{ id: 'fnav001', elType: 'widget', widgetType: 'nav-menu', settings: { layout: 'horizontal' }, elements: [] }] },
        ],
      },
    ],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const header = out.content[0];
  const footer = out.content[1];
  assert.equal(header.settings.flex_wrap_mobile, 'nowrap', 'first band (header) IS one-row forced');
  assert.notEqual(footer.settings.flex_wrap_mobile, 'nowrap', 'footer band with a nav-menu is NOT one-row forced');
});

test('two-tier stacked header (page-39 shape): topbar hides on mobile, main bar forced to a row, nav overlays', async () => {
  const page = {
    title: 'Bugsys shape',
    content: [{
      id: 'hdr0039', elType: 'container', isInner: false,
      settings: { html_tag: 'header', flex_direction: 'column', background_color: '#1a1a1a' },
      elements: [
        { id: 'topbar39', elType: 'container', isInner: true,
          settings: { flex_direction: 'row', background_color: '#1a1a1a' },
          elements: [
            { id: 'tcol0a1', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 33 } },
              elements: [{ id: 'thrs001', elType: 'widget', widgetType: 'icon-list', settings: {}, elements: [] }] },
            { id: 'tcol0a2', elType: 'container', isInner: true, settings: { width: { unit: '%', size: 33 } },
              elements: [{ id: 'tsrv001', elType: 'widget', widgetType: 'heading', settings: { title: 'Serving South Florida' }, elements: [] }] },
          ] },
        { id: 'main0039', elType: 'container', isInner: true,
          settings: { flex_direction: 'column', background_color: '#d81f26' },
          elements: [
            { id: 'mlogo39', elType: 'widget', widgetType: 'heading', settings: { title: 'BUGSYS', header_size: 'div' }, elements: [] },
            { id: 'mnav039', elType: 'widget', widgetType: 'nav-menu', settings: { layout: 'horizontal' }, elements: [] },
            { id: 'mcta039', elType: 'widget', widgetType: 'button', settings: { text: 'GET A FREE QUOTE' }, elements: [] },
          ] },
      ],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const band = out.content[0];
  const topbar = band.elements[0];
  const main = band.elements[1];
  assert.equal(topbar.settings.hide_mobile, 'hidden-phone', 'utility topbar hides on phones (never squeezed)');
  assert.equal(main.settings.hide_mobile, undefined, 'main bar stays visible');
  assert.equal(main.settings.flex_direction, 'row', 'main bar with the nav is FORCED to a row (was column)');
  assert.equal(main.settings.flex_wrap_mobile, 'nowrap', 'main bar one row on mobile');
  const nav = main.elements.find((e) => e.widgetType === 'nav-menu');
  assert.equal(nav.settings.full_width, 'stretch', 'hamburger dropdown overlays instead of expanding the header');
  const cta = main.elements.find((e) => e.widgetType === 'button');
  assert.equal(cta.settings.hide_mobile, undefined, 'CTA visible on mobile');
});

test('card grid: unfittable 2-up mobile widths are clamped (47 -> 46), too-wide go full width', async () => {
  const cards = Array.from({ length: 4 }, (_, i) => ({
    id: `gcard0${i + 1}`, elType: 'container', isInner: true,
    settings: { width: { unit: '%', size: 47 }, width_mobile: { unit: '%', size: 47 } },
    elements: [{ id: `gh000${i + 1}`, elType: 'widget', widgetType: 'heading', settings: { title: `Card ${i + 1}` }, elements: [] }],
  }));
  cards[3].settings.width_mobile = { unit: '%', size: 60 };
  const page = {
    title: 'Cards',
    content: [{
      id: 'grid039', elType: 'container', isInner: false,
      settings: { flex_direction: 'row', flex_wrap: 'wrap' },
      elements: cards,
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const kids = out.content[0].elements;
  assert.equal(kids[0].settings.width_mobile.size, 46, '47% pair clamps to 46% so two fit WITH the gap');
  assert.equal(kids[3].settings.width_mobile.size, 100, '60% cannot pair — stacks full width');
});

test('widget row (trust badges): each widget wrapped in its own centered child container (pro pattern)', async () => {
  const boxes = ['fas fa-award', 'fab fa-google', 'fas fa-shield-alt', 'fas fa-bug'].map((icon, i) => ({
    id: `badge00${i + 1}`, elType: 'widget', widgetType: 'icon-box',
    settings: {
      selected_icon: { value: icon, library: i === 1 ? 'fa-brands' : 'fa-solid' },
      title_text: `Badge ${i + 1}`, view: 'stacked', shape: 'square',
      primary_color: '#d0202a', secondary_color: '#d0202a',
    },
    elements: [],
  }));
  const page = {
    title: 'Trust strip',
    content: [{
      id: 'trust001', elType: 'container', isInner: false,
      settings: { flex_direction: 'row', flex_wrap: 'wrap', flex_justify_content: 'space-around' },
      elements: boxes,
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const row = out.content[0];
  assert.equal(row.settings.flex_wrap, undefined, '4 items = one desktop row, base wrap removed');
  assert.equal(row.settings.flex_wrap_mobile, 'wrap', 'stacks on phones');
  assert.equal(row.elements.length, 4);
  row.elements.forEach((wrapper) => {
    assert.equal(wrapper.elType, 'container', 'each item lives in its OWN child container');
    assert.equal(wrapper.settings.width.size, 24, '4 items -> 24% columns');
    assert.equal(wrapper.settings.width_mobile.size, 100, 'text items full width on phones');
    assert.equal(wrapper.settings.flex_align_items, 'center', 'centered internally');
    const b = wrapper.elements[0];
    assert.equal(b.widgetType, 'icon-box');
    assert.equal(b.settings.secondary_color, '#ffffff', 'glyph forced white (was invisible red-on-red)');
  });
});


test('testimonial-carousel is auto-converted into a row of static testimonial widgets', async () => {
  const page = {
    title: 'Slider ban',
    content: [{
      id: 'tstbnd1', elType: 'container', isInner: false, settings: {},
      elements: [{
        id: 'tstcar1', elType: 'widget', widgetType: 'testimonial-carousel',
        settings: {
          slides: [
            { _id: 's1', content: 'Great service!', name: 'Amy R.', title: 'Homeowner', image: { url: 'https://images.unsplash.com/a?w=200', id: '' } },
            { _id: 's2', content: 'Very professional.', name: 'Bob K.', title: 'Landlord', image: { url: 'https://images.unsplash.com/b?w=200', id: '' } },
            { _id: 's3', content: 'Would hire again.', name: 'Cara D.', title: 'Manager', image: { url: 'https://images.unsplash.com/c?w=200', id: '' } },
          ],
        },
        elements: [],
      }],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const s = JSON.stringify(out);
  assert.ok(!s.includes('testimonial-carousel'), 'no slider survives');
  const testimonials = [];
  (function w(els){ els.forEach((e)=>{ if(e.widgetType==='testimonial') testimonials.push(e); if(Array.isArray(e.elements)) w(e.elements); }); })(out.content);
  assert.equal(testimonials.length, 3, 'every quote became a static testimonial');
  assert.equal(testimonials[0].settings.testimonial_content, 'Great service!');
  assert.equal(testimonials[1].settings.testimonial_name, 'Bob K.');
  assert.equal(testimonials[2].settings.testimonial_job, 'Manager');
  assert.ok(out._repairs.some((r) => /sliders are never used/.test(r)));
});

test('hover polish: buttons darken on hover, card containers get lift shadows; header untouched', async () => {
  const page = {
    title: 'Hover polish',
    content: [
      { id: 'hdrhp01', elType: 'container', isInner: false, settings: { html_tag: 'header', flex_direction: 'row' },
        elements: [{ id: 'hbtnhp1', elType: 'widget', widgetType: 'button', settings: { text: 'Quote', background_color: '#d0202a' }, elements: [] }] },
      { id: 'bandhp1', elType: 'container', isInner: false, settings: {},
        elements: [
          { id: 'cardh01', elType: 'container', isInner: true, settings: { background_color: '#ffffff', border_radius: { unit: 'px', top: '12', right: '12', bottom: '12', left: '12', isLinked: true }, width: { unit: '%', size: 48 } },
            elements: [{ id: 'chh0001', elType: 'widget', widgetType: 'heading', settings: { title: 'Card A' }, elements: [] }] },
          { id: 'cardh02', elType: 'container', isInner: true, settings: { background_color: '#ffffff', width: { unit: '%', size: 48 } },
            elements: [{ id: 'cbtn001', elType: 'widget', widgetType: 'button', settings: { text: 'Go', background_color: '#5b3b8c' }, elements: [] }] },
        ] },
    ],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const hdrBtn = out.content[0].elements[0];
  assert.equal(hdrBtn.settings.button_background_hover_color, undefined, 'header button untouched');
  const cards = out.content[1].elements;
  cards.forEach((c) => {
    assert.equal(c.settings.box_shadow_hover_box_shadow_type, 'yes', 'card gets hover lift shadow');
  });
  const bodyBtn = cards[1].elements[0];
  assert.equal(bodyBtn.settings.button_background_hover_color, '#50347b', 'button hover = 12% darker fill');
});

test('entrance/scroll animations are stripped (they hide sections on cached hosts); hover keys survive', async () => {
  const page = {
    title: 'No scroll animations',
    content: [{
      id: 'animbd1', elType: 'container', isInner: false,
      settings: { animation: 'fadeInUp', animation_duration: 'fast', animation_delay: 200 },
      elements: [{
        id: 'animw01', elType: 'widget', widgetType: 'icon-box',
        settings: { title_text: 'X', _animation: 'fadeInUp', _animation_delay: 100, hover_primary_color: '#ff0000' },
        elements: [],
      }],
    }],
  };

  const out = await validateAndRepair(JSON.stringify(page), claude);
  const band = out.content[0];
  const w = band.elements[0];
  assert.equal(band.settings.animation, undefined, 'container entrance animation removed');
  assert.equal(band.settings.animation_delay, undefined);
  assert.equal(w.settings._animation, undefined, 'widget entrance animation removed');
  assert.equal(w.settings.hover_primary_color, '#ff0000', 'hover keys (pure CSS) survive');
  assert.ok(out._repairs.some((r) => /entrance\/scroll animations/.test(r)));
});

test('duplicate header bands: only the FIRST nav band survives; footer nav loses just the widget', async () => {
  const navBand = (id) => ({
    id, elType: 'container', isInner: false, settings: { flex_direction: 'row' },
    elements: [
      { id: id.slice(0, 4) + 'lg1', elType: 'widget', widgetType: 'heading', settings: { title: 'Logo', header_size: 'div' }, elements: [] },
      { id: id.slice(0, 4) + 'nv1', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] },
    ],
  });
  const page = {
    title: 'Two headers',
    content: [
      navBand('hdr1aaa'),
      navBand('hdr2bbb'), // the duplicate
      { id: 'hero111', elType: 'container', settings: {}, elements: [
        { id: 'h1x1111', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hero' }, elements: [] } ] },
      { id: 'ftr1111', elType: 'container', settings: {}, elements: [
        { id: 'ftxt111', elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>f</p>' }, elements: [] },
        { id: 'fnav111', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] } ] },
    ],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const navCount = (JSON.stringify(out).match(/"nav-menu"/g) || []).length;
  assert.equal(navCount, 1, 'exactly ONE nav-menu on the page');
  assert.equal(out.content.length, 3, 'duplicate header band removed whole; footer band kept');
  assert.ok(out.content.some((b) => b.id === 'ftr1111'), 'footer band survives (nav stripped)');
  assert.ok(out._repairs.some((r) => /ONE header/.test(r)));
});

test('price-table: default "This is a text element" footer junk is cleared', async () => {
  const page = {
    title: 'Pricing',
    content: [{ id: 'prc1111', elType: 'container', settings: {}, elements: [
      { id: 'ptbl111', elType: 'widget', widgetType: 'price-table',
        settings: { heading: 'Basic', price: '89', footer_additional_info: 'This is text element' }, elements: [] },
      { id: 'ptbl222', elType: 'widget', widgetType: 'price-table',
        settings: { heading: 'Pro', price: '149', footer_additional_info: 'No hidden fees — cancel anytime' }, elements: [] },
    ] }],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  assert.equal(out.content[0].elements[0].settings.footer_additional_info, '', 'default junk cleared');
  assert.equal(out.content[0].elements[1].settings.footer_additional_info, 'No hidden fees — cancel anytime', 'real microcopy kept');
});

test('duplicate topbar strips: identical utility strip emitted twice keeps only the first', async () => {
  const strip = (id) => ({
    id, elType: 'container', isInner: false,
    settings: { flex_direction: 'row', background_color: '#1a3a8f' },
    elements: [
      { id: id.slice(0, 4) + 'tx1', elType: 'widget', widgetType: 'heading',
        settings: { title: 'WE DISPATCH AS EARLY AS 6AM — SERVING CORONA & SURROUNDING AREAS', header_size: 'div' }, elements: [] },
    ],
  });
  const page = {
    title: 'Double topbar',
    content: [
      strip('tbar1aa'),
      strip('tbar2bb'),
      { id: 'mainhdr', elType: 'container', settings: { flex_direction: 'row' }, elements: [
        { id: 'mlogo01', elType: 'widget', widgetType: 'heading', settings: { title: 'FRINJ', header_size: 'div' }, elements: [] },
        { id: 'mnav001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] } ] },
      { id: 'hero001', elType: 'container', settings: {}, elements: [
        { id: 'hh10001', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hero' }, elements: [] } ] },
    ],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const ids = out.content.map((b) => b.id);
  assert.ok(ids.includes('tbar1aa') && !ids.includes('tbar2bb'), 'second identical strip removed');
  assert.ok(out._repairs.some((r) => /topbar strip/.test(r)));
});

test('topbar strips: NEAR-duplicate text (different separators/stars) is deduped too', async () => {
  const strip = (id, title) => ({
    id, elType: 'container', isInner: false,
    settings: { flex_direction: 'row', background_color: '#1a3a8f' },
    elements: [{ id: id.slice(0, 4) + 'tx2', elType: 'widget', widgetType: 'heading',
      settings: { title, header_size: 'div' }, elements: [] }],
  });
  const page = {
    title: 'Near-dup topbar',
    content: [
      strip('nbar1aa', 'WE DISPATCH AS EARLY AS 6 AM — SERVING CORONA & SURROUNDING AREAS · Google Top Rated 2024'),
      strip('nbar2bb', 'WE DISPATCH AS EARLY AS 6 AM • SERVING CORONA & SURROUNDING AREAS | Google — Top Rated Business 2024'),
      { id: 'mhdr001', elType: 'container', settings: { flex_direction: 'row' }, elements: [
        { id: 'mlg0001', elType: 'widget', widgetType: 'heading', settings: { title: 'FRINJ', header_size: 'div' }, elements: [] },
        { id: 'mnv0001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] } ] },
      { id: 'hero777', elType: 'container', settings: {}, elements: [
        { id: 'hh77777', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hero' }, elements: [] } ] },
    ],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const ids = out.content.map((b) => b.id);
  assert.ok(ids.includes('nbar1aa') && !ids.includes('nbar2bb'), 'near-duplicate strip removed');
});

test('header tiers: a logo/CTA row (button or image, no nav) is NEVER hidden on mobile', async () => {
  const page = {
    title: 'Split main bar',
    content: [{
      id: 'hwrap77', elType: 'container', isInner: false,
      settings: { html_tag: 'header', flex_direction: 'column' },
      elements: [
        { id: 'util077', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [{ id: 'ut77701', elType: 'widget', widgetType: 'heading',
            settings: { title: 'WE DISPATCH AS EARLY AS 6AM SERVING CORONA AREAS', header_size: 'div' }, elements: [] }] },
        { id: 'logo077', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [
            { id: 'lg77701', elType: 'widget', widgetType: 'heading', settings: { title: 'FRINJ ENERGY', header_size: 'div' }, elements: [] },
            { id: 'bt77701', elType: 'widget', widgetType: 'button', settings: { text: 'SCHEDULE NOW' }, elements: [] },
          ] },
        { id: 'nav0077', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [{ id: 'nv77701', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] }] },
      ],
    }],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const band = out.content[0];
  const util = band.elements.find((e) => e.id === 'util077');
  const logo = band.elements.find((e) => e.id === 'logo077');
  assert.equal(util.settings.hide_mobile, 'hidden-phone', 'utility strip hides on phones');
  assert.equal(logo.settings.hide_mobile, undefined, 'logo/CTA row STAYS VISIBLE on phones');
});

test('mobile nav-row declutter: logo + nav + FIRST button stay; phone texts and subtitles hide', async () => {
  const page = {
    title: 'Crammed mobile header',
    content: [{
      id: 'hdrm001', elType: 'container', isInner: false,
      settings: { flex_direction: 'row' },
      elements: [
        { id: 'mlogo01', elType: 'widget', widgetType: 'heading', settings: { title: 'FRINJ ENERGY', header_size: 'div' }, elements: [] },
        { id: 'msub001', elType: 'widget', widgetType: 'heading', settings: { title: 'HEATING & AIR CONDITIONING', header_size: 'div' }, elements: [] },
        { id: 'mnav001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] },
        { id: 'mbtn001', elType: 'widget', widgetType: 'button', settings: { text: 'SCHEDULE NOW' }, elements: [] },
        { id: 'mphn001', elType: 'widget', widgetType: 'heading', settings: { title: '(951) 407-0388', header_size: 'div' }, elements: [] },
      ],
    }],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const kids = out.content[0].elements;
  const byId = (id) => kids.find((k) => k.id === id);
  assert.equal(byId('mlogo01').settings.hide_mobile, undefined, 'logo visible');
  assert.equal(byId('mnav001').settings.hide_mobile, undefined, 'nav visible');
  assert.equal(byId('mbtn001').settings.hide_mobile, undefined, 'first button visible');
  assert.equal(byId('msub001').settings.hide_mobile, 'hidden-phone', 'subtitle hidden on phones');
  assert.equal(byId('mphn001').settings.hide_mobile, 'hidden-phone', 'phone text hidden on phones');
});

test('mobile: phone-number BUTTON hides even when it sits in a different row than the hamburger', async () => {
  const page = {
    title: 'Phone CTA row split',
    content: [{
      id: 'hwrapm2', elType: 'container', isInner: false,
      settings: { html_tag: 'header', flex_direction: 'column' },
      elements: [
        { id: 'logorw2', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [
            { id: 'lgm2001', elType: 'widget', widgetType: 'heading', settings: { title: 'FRINJ ENERGY', header_size: 'div' }, elements: [] },
            { id: 'btm2001', elType: 'widget', widgetType: 'button', settings: { text: 'SCHEDULE NOW', link: { url: '#contact' } }, elements: [] },
            { id: 'phm2001', elType: 'widget', widgetType: 'button', settings: { text: '(951) 407-0366', link: { url: 'tel:+19514070366' } }, elements: [] },
          ] },
        { id: 'navrw02', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [{ id: 'nvm2001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] }] },
      ],
    }],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const logoRow = out.content[0].elements.find((e) => e.id === 'logorw2');
  const sched = logoRow.elements.find((e) => e.id === 'btm2001');
  const phone = logoRow.elements.find((e) => e.id === 'phm2001');
  assert.equal(sched.settings.hide_mobile, undefined, 'the ONE kept CTA stays visible');
  assert.equal(phone.settings.hide_mobile, 'hidden-phone', 'phone-number button hidden on mobile');
});

test('ONE-BAR MERGE: split logo-deck + nav-deck headers become a single row (logo | nav | CTA)', async () => {
  const page = {
    title: 'Split decks',
    content: [{
      id: 'hwrapm3', elType: 'container', isInner: false,
      settings: { html_tag: 'header', flex_direction: 'column' },
      elements: [
        { id: 'utilm31', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [{ id: 'utm3001', elType: 'widget', widgetType: 'heading',
            settings: { title: 'WE DISPATCH AS EARLY AS 6AM SERVING CORONA AND AREAS', header_size: 'div' }, elements: [] }] },
        { id: 'logom31', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [
            { id: 'lgm3001', elType: 'widget', widgetType: 'heading', settings: { title: 'FRINJ ENERGY', header_size: 'div' }, elements: [] },
            { id: 'btm3001', elType: 'widget', widgetType: 'button', settings: { text: 'SCHEDULE NOW', link: { url: '#c' } }, elements: [] },
          ] },
        { id: 'navm301', elType: 'container', isInner: true, settings: { flex_direction: 'row' },
          elements: [{ id: 'nvm3001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] }] },
      ],
    }],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude, { allowPro: true });
  const band = out.content[0];
  assert.ok(!band.elements.some((e) => e.id === 'navm301'), 'empty nav deck removed');
  const logoRow = band.elements.find((e) => e.id === 'logom31');
  const order = logoRow.elements.map((e) => e.widgetType);
  assert.deepEqual(order, ['heading', 'nav-menu', 'button'], 'ONE row: logo | nav | CTA');
  const logo = logoRow.elements[0];
  assert.equal(logo.settings.hide_mobile, undefined, 'logo VISIBLE on mobile (hidden-topbar heading no longer steals the logo slot)');
  const util = band.elements.find((e) => e.id === 'utilm31');
  assert.equal(util.settings.hide_mobile, 'hidden-phone', 'utility strip still hides');
});

test('widget row: 5+ counters become a wrapping 3-up grid in child containers, 2-up on mobile', async () => {
  const counters = Array.from({ length: 6 }, (_, i) => ({
    id: `cntx00${i + 1}`, elType: 'widget', widgetType: 'counter',
    settings: { ending_number: (i + 1) * 10, suffix: '+', title: `Stat ${i + 1}` }, elements: [],
  }));
  const page = {
    title: 'Six stats',
    content: [{
      id: 'stats6x1', elType: 'container', isInner: false,
      settings: { flex_direction: 'row' },
      elements: counters,
    }],
  };
  const out = await validateAndRepair(JSON.stringify(page), claude);
  const row = out.content[0];
  assert.equal(row.settings.flex_wrap, 'wrap', '5+ items wrap into two desktop rows — never crammed in one line');
  row.elements.forEach((wrapper) => {
    assert.equal(wrapper.elType, 'container');
    assert.equal(wrapper.settings.width.size, 32, '3-up grid columns');
    assert.equal(wrapper.settings.width_mobile.size, 46, 'compact stats go 2-up on phones');
  });
});

test('usability floor: nav-menu gets full mobile burger config and never hide_mobile', () => {
  const { enforceUsabilityFloor } = require('../validator.js');
  const content = [
    { id: 'hdr0001', elType: 'container', settings: {}, elements: [
      { id: 'nav0001', elType: 'widget', widgetType: 'nav-menu',
        settings: { menu: 'main', hide_mobile: 'hidden-phone' }, elements: [] } ] },
  ];
  const repairs = [];
  enforceUsabilityFloor(content, repairs);
  const nav = content[0].elements[0].settings;
  assert.equal(nav.dropdown, 'tablet');
  assert.equal(nav.toggle, 'burger');
  assert.ok(nav.toggle_color, 'toggle color set');
  assert.equal(nav.dropdown_background_color, '#ffffff');
  assert.ok(nav.color_dropdown_item, 'dropdown item color set');
  assert.equal(nav.hide_mobile, undefined, 'nav never hidden on phones');
  assert.ok(repairs.some((r) => /burger/.test(r)));
});

test('usability floor: carousels get visible controls, tiny text raised with line-height', () => {
  const { enforceUsabilityFloor } = require('../validator.js');
  const content = [
    { id: 'band001', elType: 'container', settings: {}, elements: [
      { id: 'car0001', elType: 'widget', widgetType: 'image-carousel', settings: {}, elements: [] },
      { id: 'txt0001', elType: 'widget', widgetType: 'text-editor',
        settings: { typography_typography: 'custom', typography_font_size: { unit: 'px', size: 11, sizes: [] } }, elements: [] },
      { id: 'txt0002', elType: 'widget', widgetType: 'text-editor', settings: {}, elements: [] } ] },
  ];
  enforceUsabilityFloor(content, []);
  const [car, small, plain] = content[0].elements.map((e) => e.settings);
  assert.equal(car.arrows_color, '#333333');
  assert.equal(car.dots_color, '#333333');
  assert.equal(small.typography_font_size.size, 13, '11px raised to 13px');
  assert.equal(small.typography_line_height.size, 1.6, 'line-height added');
  assert.equal(plain.typography_font_size, undefined, 'unsized text untouched');
});
