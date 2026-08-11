/**
 * ============================================================
 * FILE: backend/proReport.js
 *
 * Pro-widget usage report. Walks a validated Elementor element
 * tree, counts every widgetType that belongs to the Elementor Pro
 * whitelist, and pairs each with a suggested free-widget
 * alternative so the UI can warn users publishing to a site
 * without Elementor Pro.
 *
 * buildProReport(content, allowPro)
 *   -> { used: [{ widget, count, freeAlternative }], allowPro }
 * ============================================================
 */

'use strict';

const { PRO_WIDGET_WHITELIST } = require('./validator');

/** widget -> what to use instead on a free-only site. */
const FREE_ALTERNATIVES = {
  global: '(site global widget — embed of a saved Pro template)',
  'form': 'text-editor (static form markup)',
  'nav-menu': 'icon-list',
  'slides': 'image-carousel',
  'testimonial-carousel': 'testimonial + star-rating',
  'media-carousel': 'image-carousel',
  'price-table': 'styled container + icon-list',
  'price-list': 'icon-list',
  'call-to-action': 'container + heading + button',
  'flip-box': 'icon-box',
  'posts': 'hand-built cards (static)',
  'portfolio': 'image-gallery',
  'animated-headline': 'heading',
  'countdown': 'heading',
  'share-buttons': 'social-icons',
  'blockquote': 'testimonial',
  'gallery': 'image-gallery',
  'lottie': 'image',
  'hotspot': 'image',
  'reviews': 'testimonial',
  'table-of-contents': 'icon-list',
  'author-box': 'text-editor',
  'login': '(no free equivalent)',
  'search': '(no free equivalent)',
  'code-highlight': 'text-editor',
  'progress-tracker': 'progress',
  'loop-grid': 'image-box teaser cards',
  'taxonomy-filter': 'category link buttons',
};

/**
 * @param {Array} content  validated Elementor element tree (page.content)
 * @param {boolean} allowPro  whether Pro widgets were permitted this run
 * @returns {{used: Array<{widget: string, count: number, freeAlternative: string}>, allowPro: boolean}}
 */
function buildProReport(content, allowPro) {
  const counts = new Map();

  function walk(elements) {
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      if (el.elType === 'widget' && typeof el.widgetType === 'string' &&
          PRO_WIDGET_WHITELIST.has(el.widgetType)) {
        counts.set(el.widgetType, (counts.get(el.widgetType) || 0) + 1);
      }
      if (Array.isArray(el.elements) && el.elements.length) walk(el.elements);
    }
  }
  walk(Array.isArray(content) ? content : []);

  const used = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([widget, count]) => ({
      widget,
      count,
      freeAlternative: FREE_ALTERNATIVES[widget] || '(no free equivalent)',
    }));

  return { used, allowPro: !!allowPro };
}

module.exports = { buildProReport, FREE_ALTERNATIVES };
