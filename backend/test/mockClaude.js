/**
 * ============================================================
 * FILE: backend/test/mockClaude.js
 * OWNER: Person 10 (QA)
 *
 * Deterministic stand-in for createClaudeClient(). Same method
 * surface: rawMessage, extractDesignSystem, generatePage,
 * critiquePage, repairJson. Lets validator + pipeline be tested
 * offline with no API key.
 * ============================================================
 */

'use strict';

// A tiny but valid one-section page the mock "generates".
function samplePage(title = 'Mock Page') {
  return {
    title,
    page_settings: { hide_title: 'yes' },
    content: [
      {
        id: 'sec0001',
        elType: 'section',
        isInner: false,
        settings: { background_background: 'classic', background_color: '#111318' },
        elements: [
          {
            id: 'col0001',
            elType: 'column',
            isInner: false,
            settings: { _column_size: 100, _inline_size: null },
            elements: [
              // NOTE: no menu-anchor here — anchors are never used; the
              // validator deletes every one on sight. A spacer keeps the
              // historical element indexes (tests read elements[2]).
              { id: 'spc0001', elType: 'widget', widgetType: 'spacer', settings: { space: { unit: 'px', size: 8, sizes: [] } }, elements: [] },
              {
                id: 'hed0001', elType: 'widget', widgetType: 'heading',
                settings: {
                  title: 'Hello from the mock', header_size: 'h1', title_color: '#FFFFFF',
                  typography_typography: 'custom', typography_font_family: 'Poppins',
                },
                elements: [],
              },
              {
                id: 'img0001', elType: 'widget', widgetType: 'image',
                settings: {
                  image: { url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1400', id: '', alt: 'office', source: 'library' },
                  image_size: 'full',
                },
                elements: [],
              },
            ],
          },
        ],
      },
    ],
    custom_css: '',
  };
}

// A one-section page that includes an Elementor Pro widget ('form').
// Used to prove Pro widgets survive when allowPro is true.
function samplePageWithPro(title = 'Mock Pro Page') {
  const page = samplePage(title);
  const column = page.content[0].elements[0];
  column.elements.push({
    id: 'frm00001',
    elType: 'widget',
    widgetType: 'form',
    settings: {
      form_name: 'Contact',
      form_fields: [
        { _id: 'name', field_type: 'text', field_label: 'Name', placeholder: 'Your name' },
        { _id: 'email', field_type: 'email', field_label: 'Email', placeholder: 'you@example.com' },
      ],
      button_text: 'Send',
    },
    elements: [],
  });
  return page;
}

function sampleDesignSystem() {
  return {
    palette: { bg: '#111318', panel: '#171a21', card: '#1c2029', accent: '#4c8bf5', heading_text: '#ffffff', body_text: '#8b93a1', line: '#2a2f3a' },
    typography: { heading_font: 'Poppins', body_font: 'Inter', sizing_scale: 'h1 ~52, body ~16', treatments: 'bold sans headings' },
    components: { buttons: 'solid accent', cards: 'dark bordered', icon_style: 'line', spacing_rhythm: 'generous', decorative_motifs: 'none' },
    mood: 'clean, modern',
    sections: ['header', 'hero', 'features', 'contact'],
  };
}

function createMockClaude(opts = {}) {
  return {
    model: 'mock-model',
    async rawMessage() { return JSON.stringify(samplePage()); },
    async extractDesignSystem() { return JSON.stringify(sampleDesignSystem()); },
    // Accepts the full v2 arg surface: { prompt, designSystem, currentPage,
    // editInstruction, allowPro, brandContext, brandKit }. Extra args are
    // ignored deterministically. When allowPro is true, include a Pro widget
    // so pipeline/validator behavior can be exercised.
    async generatePage({ prompt, allowPro } = {}) {
      const title = prompt ? prompt.slice(0, 24) : 'Mock Page';
      return JSON.stringify(allowPro ? samplePageWithPro(title) : samplePage(title));
    },
    // Section refine: echo the incoming element back unchanged (valid JSON).
    async refineElement({ elementJson } = {}) {
      return JSON.stringify(elementJson || samplePage().content[0]);
    },
    // Self-critique / refine pass. Returns a valid improved page JSON string.
    // Echoes the incoming page (keeping it valid) when one is supplied.
    async critiquePage({ pageJson } = {}) {
      if (pageJson && typeof pageJson === 'object' && Array.isArray(pageJson.content)) {
        return JSON.stringify({ ...pageJson, title: pageJson.title || 'Mock Page' });
      }
      return JSON.stringify(samplePage('Refined'));
    },
    async repairJson(broken) {
      // If the test wants to simulate a successful repair, return valid page.
      if (opts.repairReturns) return opts.repairReturns;
      return JSON.stringify(samplePage('Repaired'));
    },
  };
}

module.exports = { createMockClaude, samplePage, samplePageWithPro, sampleDesignSystem };
