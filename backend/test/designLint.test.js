const test = require('node:test');
const assert = require('node:assert');
const { designLint } = require('../generatePipeline.js');

const twoTierSpec = {
  sections: ['Header', 'Hero'],
  header: {
    tiers: [
      { role: 'topbar', background: '#c8102e', left: 'phone', right: 'socials + links' },
      { role: 'main', background: '#000000', left: 'logo', center: 'nav', right: 'CTA' },
    ],
    cta: { label: 'GET YOUR FREE ESTIMATE', style: 'white filled rectangle' },
  },
};

const navWidget = { id: 'nav0001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] };

test('designLint flags a 2-tier reference header flattened into ONE bar', () => {
  const page = {
    content: [
      { id: 'hdr0001', elType: 'container', settings: { html_tag: 'header', flex_direction: 'row' },
        elements: [
          { id: 'logo001', elType: 'widget', widgetType: 'heading', settings: { title: 'Bugsys', header_size: 'div' }, elements: [] },
          navWidget,
        ] },
      { id: 'hero001', elType: 'container', settings: {}, elements: [
        { id: 'h100001', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Expert Pest Control' }, elements: [] } ] },
    ],
  };
  const notes = designLint(page, twoTierSpec, true, 'full');
  assert.ok(notes.some((n) => /2 tiers/.test(n)), `expected tier note, got: ${notes.join(' | ')}`);
});

test('designLint accepts a 2-tier header built as two rows inside the header band', () => {
  const page = {
    content: [
      { id: 'hdr0002', elType: 'container', settings: { html_tag: 'header' },
        elements: [
          { id: 'topbar01', elType: 'container', settings: { flex_direction: 'row', background_color: '#c8102e' },
            elements: [{ id: 'tph0001', elType: 'widget', widgetType: 'icon-list', settings: {}, elements: [] }] },
          { id: 'mainbar1', elType: 'container', settings: { flex_direction: 'row', background_color: '#000000' },
            elements: [navWidget] },
        ] },
      { id: 'hero002', elType: 'container', settings: {}, elements: [
        { id: 'h100002', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Expert Pest Control' }, elements: [] } ] },
    ],
  };
  const notes = designLint(page, twoTierSpec, true, 'full');
  assert.ok(!notes.some((n) => /tiers/.test(n)), `unexpected tier note: ${notes.join(' | ')}`);
});

test('designLint accepts a separate top-level topbar band before the header band', () => {
  const page = {
    content: [
      { id: 'topband1', elType: 'container', settings: { flex_direction: 'row', background_color: '#c8102e' },
        elements: [{ id: 'tt00001', elType: 'widget', widgetType: 'icon-list', settings: {}, elements: [] }] },
      { id: 'hdr0003', elType: 'container', settings: { flex_direction: 'row' }, elements: [navWidget] },
      { id: 'hero003', elType: 'container', settings: {}, elements: [
        { id: 'h100003', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Expert' }, elements: [] } ] },
    ],
  };
  const notes = designLint(page, twoTierSpec, true, 'full');
  assert.ok(!notes.some((n) => /tiers/.test(n)), `unexpected tier note: ${notes.join(' | ')}`);
});

test('designLint flags a blog band built without the posts widget (Pro)', () => {
  const ds = { sections: ['Hero', 'Blog: From Our Blog — 3 post cards with dates and Read More links'] };
  const page = {
    content: [
      { id: 'hero0b1', elType: 'container', settings: {}, elements: [
        { id: 'h1000b1', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hi' }, elements: [] } ] },
      { id: 'blog0b1', elType: 'container', settings: {}, elements: [
        { id: 'bh000b1', elType: 'widget', widgetType: 'heading', settings: { title: 'From Our Blog' }, elements: [] } ] },
    ],
  };
  const notes = designLint(page, ds, true, 'none');
  assert.ok(notes.some((n) => /posts widget/.test(n)), `expected posts note, got: ${notes.join(' | ')}`);
});

test('designLint stays quiet when the posts widget IS used for the blog band', () => {
  const ds = { sections: ['Hero', 'Blog: latest news cards'] };
  const page = {
    content: [
      { id: 'hero0b2', elType: 'container', settings: {}, elements: [
        { id: 'h1000b2', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hi' }, elements: [] } ] },
      { id: 'blog0b2', elType: 'container', settings: {}, elements: [
        { id: 'posts0b2', elType: 'widget', widgetType: 'posts', settings: { _skin: 'classic' }, elements: [] } ] },
    ],
  };
  const notes = designLint(page, ds, true, 'none');
  assert.ok(!notes.some((n) => /posts widget/.test(n)), `unexpected posts note: ${notes.join(' | ')}`);
});

test('designLint flags an INVENTED blog section (reference has none)', () => {
  const ds = { sections: ['Hero', 'Services', 'FAQ'] };
  const page = {
    content: [
      { id: 'h000001', elType: 'container', settings: {}, elements: [
        { id: 'hh00001', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hi' }, elements: [] } ] },
      { id: 'b000001', elType: 'container', settings: {}, elements: [
        { id: 'bp00001', elType: 'widget', widgetType: 'posts', settings: {}, elements: [] } ] },
    ],
  };
  const notes = designLint(page, ds, true, 'none');
  assert.ok(notes.some((n) => /invented blog/.test(n)), `expected invented-blog note, got: ${notes.join(' | ')}`);
});

test('designLint flags an INVENTED gallery, stays quiet when the reference shows one', () => {
  const page = {
    content: [
      { id: 'h000002', elType: 'container', settings: {}, elements: [
        { id: 'hh00002', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hi' }, elements: [] } ] },
      { id: 'g000002', elType: 'container', settings: {}, elements: [
        { id: 'gc00002', elType: 'widget', widgetType: 'image-carousel', settings: { carousel: [{ id: '', url: 'https://x/1.jpg' }] }, elements: [] } ] },
    ],
  };
  const without = designLint(page, { sections: ['Hero', 'About'] }, true, 'none');
  assert.ok(without.some((n) => /invented gallery/.test(n)), 'flags when reference lacks a gallery');
  const withGallery = designLint(page, { sections: ['Hero', 'Recent installs photo gallery'] }, true, 'none');
  assert.ok(!withGallery.some((n) => /invented gallery/.test(n)), 'quiet when the reference shows one');
});

test('invented checks are BLIND-PROOF: styling words like "photos"/"read more" outside sections do not mask them', () => {
  const ds = {
    sections: ['Hero: dark photo', 'Services zig-zag', 'FAQ'],
    effects: { imagery_treatment: 'rounded photos with soft shadows' },
    components: { buttons: 'orange read more style buttons with carousel arrows' },
  };
  const page = {
    content: [
      { id: 'h777771', elType: 'container', settings: {}, elements: [
        { id: 'hh77771', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hi' }, elements: [] } ] },
      { id: 'b777772', elType: 'container', settings: {}, elements: [
        { id: 'bp77772', elType: 'widget', widgetType: 'posts', settings: {}, elements: [] } ] },
      { id: 'g777773', elType: 'container', settings: {}, elements: [
        { id: 'gc77773', elType: 'widget', widgetType: 'image-carousel', settings: { carousel: [{ id: '', url: 'https://x/1.jpg' }] }, elements: [] } ] },
    ],
  };
  const notes = designLint(page, ds, true, 'none');
  assert.ok(notes.some((n) => /invented blog/.test(n)), 'blog flagged despite read-more styling text');
  assert.ok(notes.some((n) => /invented gallery/.test(n)), 'gallery flagged despite photos/carousel styling text');
});

test('designLint flags flattened diagonal/gradient backgrounds', () => {
  const ds = { sections: ['Hero | bg: flat #ffffff', 'FAQ split | bg: white with ORANGE DIAGONAL WEDGE right (~115°, #E8611D hard stop 62%)'] };
  const flatPage = {
    content: [
      { id: 'x900001', elType: 'container', settings: { background_background: 'classic', background_color: '#ffffff' }, elements: [
        { id: 'xh90001', elType: 'widget', widgetType: 'heading', settings: { header_size: 'h1', title: 'Hi' }, elements: [] } ] },
      { id: 'x900002', elType: 'container', settings: { background_background: 'classic', background_color: '#ffffff' }, elements: [
        { id: 'xa90002', elType: 'widget', widgetType: 'accordion', settings: {}, elements: [] } ] },
    ],
  };
  const notes = designLint(flatPage, ds, true, 'none');
  assert.ok(notes.some((n) => /gradient backgrounds/.test(n)), `expected flatten note, got: ${notes.join(' | ')}`);
  // Quiet when a gradient band exists.
  flatPage.content[1].settings = { background_background: 'gradient', background_color: '#E8611D', background_color_b: '#ffffff' };
  const notes2 = designLint(flatPage, ds, true, 'none');
  assert.ok(!notes2.some((n) => /gradient backgrounds/.test(n)), 'quiet when gradients exist');
});

test('lint: reference map without google_maps widget is flagged; static-map page fails', () => {
  const { designLint } = require('../generatePipeline.js');
  const ds = { sections: ['Contact: heading + google maps embed | bg: white'], palette: {} };
  const page = { content: [
    { id: 'cta0001', elType: 'container', settings: {}, elements: [
      { id: 'img0001', elType: 'widget', widgetType: 'image', settings: { image: { url: 'https://x/map.jpg' } }, elements: [] } ] },
  ] };
  const notes = designLint(page, ds, true, 'none');
  assert.ok(notes.some((n) => /google_maps/.test(n)), 'map rule fires');
});

test('lint: tabs/accordion invented against a reference without them are flagged', () => {
  const { designLint } = require('../generatePipeline.js');
  const ds = { sections: ['Services: 3 photo cards | bg: grey', 'Hero: heading + button | bg: navy'], palette: {} };
  const page = { content: [
    { id: 'svc0001', elType: 'container', settings: {}, elements: [
      { id: 'tab0001', elType: 'widget', widgetType: 'tabs', settings: {}, elements: [] },
      { id: 'acc0001', elType: 'widget', widgetType: 'accordion', settings: {}, elements: [] } ] },
  ] };
  const notes = designLint(page, ds, true, 'none');
  assert.ok(notes.some((n) => /tabs widget/.test(n)), 'tabs misuse flagged');
  assert.ok(notes.some((n) => /accordion\/toggle/.test(n)), 'invented FAQ flagged');
});

test('lint: partial reference padded out to a full page is flagged (too many bands)', () => {
  const { designLint } = require('../generatePipeline.js');
  const ds = { sections: ['Header: logo + nav + CTA | bg: white', 'Hero: heading + 2 buttons + photo | bg: navy'], palette: {} };
  const mkBand = (id) => ({ id, elType: 'container', settings: {}, elements: [
    { id: id.slice(0, 4) + 'wid', elType: 'widget', widgetType: 'heading', settings: {}, elements: [] } ] });
  const page = { content: ['band001', 'band002', 'band003', 'band004', 'band005', 'band006'].map(mkBand) };
  const notes = designLint(page, ds, true, 'full');
  assert.ok(notes.some((n) => /ENTIRE scope/.test(n)), 'padded-page note fires');
  // A page matching the reference count (or +1) stays clean of that note.
  const okPage = { content: ['band001', 'band002', 'band003'].map(mkBand) };
  const okNotes = designLint(okPage, ds, true, 'full');
  assert.ok(!okNotes.some((n) => /ENTIRE scope/.test(n)), 'tolerance respected');
});
