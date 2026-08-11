/**
 * ============================================================
 * FILE: backend/brandKits.js
 * OWNER: Person 4 (orchestrator)
 *
 * A library of ready-made brand kits. Each kit is a plain object
 * handed to the model to lock palette + fonts:
 *
 *   { id, name, category,
 *     palette: { bg, surface, card, text, heading, accent, muted, line },
 *     fonts:   { heading, body },
 *     swatches: [hex, ...] }   // for the picker preview
 *
 * Injected verbatim into the generation USER message (never the
 * cached system prompt) so styling still lives inside the Elementor
 * JSON via native settings.
 *
 * The 10 curated presets are adapted from the EMCP free brand-kit
 * library (professional palette + Google-font pairings); "brandbuzz"
 * is a light orange marketing-agency kit that matches the common
 * agency reference design.
 * ============================================================
 */

'use strict';

const BRAND_KITS = [
  {
    id: 'brandbuzz', name: 'BrandBuzz — Orange Agency', category: 'creative',
    palette: { bg: '#ffffff', surface: '#fff7f2', card: '#ffffff', text: '#4a4a4a', heading: '#0b1f3a', accent: '#F26A21', muted: '#7a7a7a', line: '#efe7e1' },
    fonts: { heading: 'Poppins', body: 'Poppins' },
    swatches: ['#F26A21', '#0b1f3a', '#fff7f2', '#4a4a4a'],
  },
  {
    id: 'enterprise-blue', name: 'Enterprise Blue', category: 'corporate',
    palette: { bg: '#F9FAFB', surface: '#ffffff', card: '#ffffff', text: '#1F2937', heading: '#1E3A5F', accent: '#2563EB', muted: '#334155', line: '#E5E7EB' },
    fonts: { heading: 'Source Sans 3', body: 'Source Sans 3' },
    swatches: ['#2563EB', '#1E3A5F', '#F9FAFB', '#1F2937'],
  },
  {
    id: 'modern-saas', name: 'Modern SaaS', category: 'corporate',
    palette: { bg: '#F8FAFC', surface: '#ffffff', card: '#ffffff', text: '#1E293B', heading: '#0F172A', accent: '#4F46E5', muted: '#64748B', line: '#E2E8F0' },
    fonts: { heading: 'Inter', body: 'Inter' },
    swatches: ['#4F46E5', '#0F172A', '#F8FAFC', '#1E293B'],
  },
  {
    id: 'bold-studio', name: 'Bold Studio', category: 'creative',
    palette: { bg: '#FAFAFA', surface: '#ffffff', card: '#ffffff', text: '#18181B', heading: '#18181B', accent: '#E11D48', muted: '#52525B', line: '#E4E4E7' },
    fonts: { heading: 'Anton', body: 'Work Sans' },
    swatches: ['#E11D48', '#18181B', '#FAFAFA', '#52525B'],
  },
  {
    id: 'boutique-rose', name: 'Boutique Rose', category: 'ecommerce',
    palette: { bg: '#FFF1F2', surface: '#ffffff', card: '#ffffff', text: '#3B2A2A', heading: '#9D174D', accent: '#BE185D', muted: '#8A6D6D', line: '#F3D9DE' },
    fonts: { heading: 'Fraunces', body: 'Inter' },
    swatches: ['#BE185D', '#9D174D', '#FFF1F2', '#3B2A2A'],
  },
  {
    id: 'magazine-classic', name: 'Magazine Classic', category: 'editorial',
    palette: { bg: '#FAFAFA', surface: '#ffffff', card: '#ffffff', text: '#27272A', heading: '#18181B', accent: '#DC2626', muted: '#52525B', line: '#E5E5E5' },
    fonts: { heading: 'Libre Baskerville', body: 'Source Serif 4' },
    swatches: ['#DC2626', '#18181B', '#FAFAFA', '#27272A'],
  },
  {
    id: 'fine-dining', name: 'Fine Dining', category: 'hospitality',
    palette: { bg: '#FAFAF9', surface: '#ffffff', card: '#ffffff', text: '#292524', heading: '#1C1917', accent: '#A16207', muted: '#78716C', line: '#E7E5E4' },
    fonts: { heading: 'Cormorant Garamond', body: 'EB Garamond' },
    swatches: ['#A16207', '#1C1917', '#FAFAF9', '#292524'],
  },
  {
    id: 'restaurant-warm', name: 'Restaurant Warm', category: 'hospitality',
    palette: { bg: '#FBF6EC', surface: '#ffffff', card: '#ffffff', text: '#2A2118', heading: '#9A3412', accent: '#B45309', muted: '#6B5D4A', line: '#EADFC9' },
    fonts: { heading: 'Playfair Display', body: 'Lato' },
    swatches: ['#B45309', '#9A3412', '#FBF6EC', '#2A2118'],
  },
  {
    id: 'construction-pro', name: 'Construction Pro', category: 'trades',
    palette: { bg: '#F4F5F7', surface: '#ffffff', card: '#ffffff', text: '#1E293B', heading: '#1E293B', accent: '#F97316', muted: '#64748B', line: '#E2E5EA' },
    fonts: { heading: 'Oswald', body: 'Source Sans 3' },
    swatches: ['#F97316', '#1E293B', '#F4F5F7', '#64748B'],
  },
  {
    id: 'calm-spa', name: 'Calm Spa', category: 'wellness',
    palette: { bg: '#F0FDFA', surface: '#ffffff', card: '#ffffff', text: '#1F2937', heading: '#115E59', accent: '#0F766E', muted: '#5B7C77', line: '#CCFBF1' },
    fonts: { heading: 'Crimson Pro', body: 'Mulish' },
    swatches: ['#0F766E', '#115E59', '#F0FDFA', '#1F2937'],
  },
  {
    id: 'fitness-energy', name: 'Fitness Energy', category: 'wellness',
    palette: { bg: '#F7FEE7', surface: '#ffffff', card: '#ffffff', text: '#18181B', heading: '#18181B', accent: '#4D7C0F', muted: '#3F3F46', line: '#ECFCCB' },
    fonts: { heading: 'Archivo', body: 'Inter' },
    swatches: ['#4D7C0F', '#18181B', '#F7FEE7', '#3F3F46'],
  },
  {
    id: 'onyx', name: 'Onyx — Dark', category: 'creative',
    palette: { bg: '#0f1115', surface: '#171a21', card: '#1b1f27', text: '#c9ccd3', heading: '#f4f1ea', accent: '#C9A227', muted: '#8a8f99', line: '#262a33' },
    fonts: { heading: 'Fraunces', body: 'Inter' },
    swatches: ['#C9A227', '#f4f1ea', '#0f1115', '#c9ccd3'],
  },
];

/**
 * @param {string} id
 * @returns {Object|null} the matching kit (or null when not found)
 */
function getBrandKit(id) {
  if (!id) return null;
  return BRAND_KITS.find((k) => k.id === id) || null;
}

module.exports = { BRAND_KITS, getBrandKit };
