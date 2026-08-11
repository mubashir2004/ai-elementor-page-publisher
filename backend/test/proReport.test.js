'use strict';

/**
 * Tests for backend/proReport.js — counting Pro widgets across a nested
 * element tree and pairing each with its suggested free alternative.
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildProReport, FREE_ALTERNATIVES } = require('../proReport');
const { PRO_WIDGET_WHITELIST } = require('../validator');

const widget = (widgetType) => ({ id: 'w' + widgetType, elType: 'widget', widgetType, settings: {}, elements: [] });

test('buildProReport counts Pro widgets in nested containers and maps free alternatives', () => {
  const content = [
    {
      id: 'c1', elType: 'container', settings: {},
      elements: [
        widget('heading'),          // free — must NOT be reported
        widget('form'),
        {
          id: 'c2', elType: 'container', isInner: true, settings: {},
          elements: [widget('form'), widget('nav-menu'), widget('button')],
        },
      ],
    },
    {
      id: 'c3', elType: 'container', settings: {},
      elements: [widget('login')],
    },
  ];

  const report = buildProReport(content, true);
  assert.ok(Array.isArray(report.used));
  assert.strictEqual(report.used.length, 3, 'only pro widgets are reported');

  const byWidget = Object.fromEntries(report.used.map((u) => [u.widget, u]));
  assert.strictEqual(byWidget.form.count, 2);
  assert.strictEqual(byWidget.form.freeAlternative, 'text-editor (static form markup)');
  assert.strictEqual(byWidget['nav-menu'].count, 1);
  assert.strictEqual(byWidget['nav-menu'].freeAlternative, 'icon-list');
  assert.strictEqual(byWidget.login.freeAlternative, '(no free equivalent)');

  // Highest count first.
  assert.strictEqual(report.used[0].widget, 'form');

  // Free widgets never leak into the report.
  assert.ok(!byWidget.heading && !byWidget.button);
});

test('buildProReport returns an empty report for pro-free or empty content', () => {
  const freeOnly = [
    { id: 'c1', elType: 'container', settings: {}, elements: [widget('heading'), widget('text-editor')] },
  ];
  assert.deepStrictEqual(buildProReport(freeOnly, false).used, []);
  assert.deepStrictEqual(buildProReport([], true).used, []);
  assert.deepStrictEqual(buildProReport(null, false).used, []);
});

test('every whitelisted Pro widget has a free alternative in the report', () => {
  const content = [{
    id: 'c1', elType: 'container', settings: {},
    elements: [...PRO_WIDGET_WHITELIST].map(widget),
  }];
  const report = buildProReport(content, true);
  assert.strictEqual(report.used.length, PRO_WIDGET_WHITELIST.size);
  for (const u of report.used) {
    assert.strictEqual(u.count, 1);
    assert.ok(typeof u.freeAlternative === 'string' && u.freeAlternative.length > 0,
      `missing free alternative for "${u.widget}"`);
    assert.strictEqual(u.freeAlternative, FREE_ALTERNATIVES[u.widget]);
  }
});
