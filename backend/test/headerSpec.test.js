const test = require('node:test');
const assert = require('node:assert');
const { enforceHeaderSpec } = require('../generatePipeline.js');

test('enforceHeaderSpec: swapped tier colors are corrected and the CTA label is made verbatim', () => {
  const page = {
    content: [{
      id: 'hdr0001', elType: 'container',
      settings: { html_tag: 'header', flex_direction: 'column' },
      elements: [
        { id: 'tier0001', elType: 'container', settings: { background_color: '#1a1a1a' }, elements: [] },
        { id: 'tier0002', elType: 'container', settings: { background_color: '#d81f26' },
          elements: [
            { id: 'nav00001', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] },
            { id: 'cta00001', elType: 'widget', widgetType: 'button', settings: { text: 'GET A FREE QUOTE' }, elements: [] },
          ] },
      ],
    }],
    _repairs: [],
  };
  const spec = {
    tiers: [
      { role: 'topbar', background: '#C8102E' },
      { role: 'main', background: '#000000' },
    ],
    cta: { label: 'GET YOUR FREE ESTIMATE', style: 'white filled rectangle' },
  };
  enforceHeaderSpec(page, spec);
  assert.equal(page.content[0].elements[0].settings.background_color, '#C8102E', 'topbar takes the spec RED');
  assert.equal(page.content[0].elements[1].settings.background_color, '#000000', 'main bar takes the spec BLACK');
  const btn = page.content[0].elements[1].elements[1];
  assert.equal(btn.settings.text, 'GET YOUR FREE ESTIMATE', 'CTA label verbatim from the reference');
  assert.ok(page._repairs.some((r) => /Header corrected/.test(r)));
});

test('enforceHeaderSpec: non-hex tier backgrounds and matching values are left untouched', () => {
  const page = {
    content: [{
      id: 'hdr0002', elType: 'container',
      settings: { html_tag: 'header', flex_direction: 'row', background_color: '#ffffff' },
      elements: [
        { id: 'nav00002', elType: 'widget', widgetType: 'nav-menu', settings: {}, elements: [] },
      ],
    }],
    _repairs: [],
  };
  enforceHeaderSpec(page, { tiers: [{ role: 'main', background: 'transparent over hero' }], cta: {} });
  assert.equal(page.content[0].settings.background_color, '#ffffff', 'non-hex spec value leaves the build alone');
  assert.equal(page._repairs.length, 0, 'no note when nothing changed');
});
