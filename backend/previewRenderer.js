/**
 * ============================================================
 * FILE: backend/previewRenderer.js
 * OWNER: Person 2 (server + preview)
 *
 * Best-effort Elementor-JSON -> static HTML preview.
 *
 * renderPage(pageJson) -> a COMPLETE html document string.
 *
 * This is a *visual approximation* of what the generated page
 * will look like once published — NOT a pixel-perfect render.
 * It walks the Elementor tree (sections -> columns -> widgets)
 * and maps the native widget settings the pipeline emits to
 * plain HTML/CSS. Covers the free widget set plus the priority
 * Pro widgets. Unknown widgets fall back to a labeled box.
 *
 * No external assets, no network — safe to embed via srcdoc.
 * ============================================================
 */

'use strict';

/* ----------------------------- helpers ----------------------------- */

// Device the current render targets — set by renderPage(pageJson, {device}).
// Elementor cascade: mobile falls back to tablet, tablet falls back to desktop.
let DEVICE = 'desktop';

/**
 * Resolve responsive setting keys for the active device: `<key>_tablet`
 * overrides the base on tablet, `<key>_mobile` (falling back through
 * `<key>_tablet`) overrides on mobile. Returns a shallow clone.
 */
function resolveResponsive(settings) {
  if (!settings || typeof settings !== 'object' || DEVICE === 'desktop') return settings || {};
  const out = { ...settings };
  const apply = (suffix) => {
    for (const key of Object.keys(settings)) {
      if (key.endsWith(suffix)) {
        const base = key.slice(0, -suffix.length);
        const v = settings[key];
        const empty = v == null || v === '' ||
          (typeof v === 'object' && !Array.isArray(v) && v.size === '' && v.top == null);
        if (!empty) out[base] = v;
      }
    }
  };
  apply('_tablet');
  if (DEVICE === 'mobile') apply('_mobile');
  return out;
}

/** True when the element is hidden on the active device (hide_* keys). */
function hiddenOnDevice(el) {
  const s = el && el.settings;
  if (!s || typeof s !== 'object') return false;
  if (DEVICE === 'desktop') return !!s.hide_desktop;
  if (DEVICE === 'tablet') return !!s.hide_tablet;
  return !!s.hide_mobile;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Basic sanitize for rich-text (text-editor). Strip script/style/on* and iframes. */
function sanitizeHtml(html) {
  return String(html == null ? '' : html)
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Escape a title-like string but allow a small whitelist of inline
 * formatting tags — <span|em|strong|b|i|br> — so model output like
 * `Grow <span style="color:#4c8bf5">Faster</span>` renders styled instead
 * of as literal text. Every attribute is stripped except a style attribute,
 * which is reduced to color/font-weight/font-style declarations with safe
 * values (url(, expression, javascript: are rejected). All other tags and
 * text are escaped, and the output is always tag-balanced.
 */
function renderInlineHtml(text) {
  const src = String(text == null ? '' : text);
  if (src.indexOf('<') === -1) return esc(src); // fast path: plain text
  const tagRe = /<\s*(\/?)\s*(span|em|strong|b|i|br)\b([^>]*?)\/?\s*>/gi;
  let out = '';
  let last = 0;
  const stack = [];
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    last = tagRe.lastIndex;
    const tag = m[2].toLowerCase();
    if (tag === 'br') { out += '<br>'; continue; }
    if (m[1] === '/') {
      const at = stack.lastIndexOf(tag);
      if (at !== -1) {
        // Close anything opened after it too, so nesting stays valid.
        while (stack.length > at) out += `</${stack.pop()}>`;
      }
      continue; // stray closers are dropped
    }
    const style = sanitizeInlineStyle(extractStyleAttr(m[3]));
    out += style ? `<${tag} style="${esc(style)}">` : `<${tag}>`;
    stack.push(tag);
  }
  out += esc(src.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/** Pull the raw value of a style="..." attribute out of an attribute blob. */
function extractStyleAttr(attrs) {
  const m = String(attrs || '').match(/style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if (!m) return '';
  return m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
}

/** Keep ONLY color / font-weight / font-style declarations with safe values. */
function sanitizeInlineStyle(style) {
  if (!style) return '';
  const kept = [];
  for (const decl of String(style).split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (prop !== 'color' && prop !== 'font-weight' && prop !== 'font-style') continue;
    if (!val || /url\s*\(|expression|javascript:|[<>"'\\]/i.test(val)) continue;
    kept.push(`${prop}:${val}`);
  }
  return kept.join(';');
}

/** Turn a plain string into a CSS-safe url()/color token; drop obviously bad values. */
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^javascript:/i.test(s)) return '';
  if (/[)"'<>]/.test(s) && !/^https?:\/\//i.test(s) && !/^data:image\//i.test(s)) return '';
  return s;
}

function isColor(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Elementor dimension objects: { unit, top, right, bottom, left }. */
function dim4(obj, prop) {
  if (!obj || typeof obj !== 'object') return '';
  const unit = obj.unit || 'px';
  const has = ['top', 'right', 'bottom', 'left'].some((k) => obj[k] !== '' && obj[k] != null);
  if (!has) return '';
  const val = (k) => {
    const n = obj[k];
    return (n === '' || n == null) ? '0' : n;
  };
  return `${prop}:${val('top')}${unit} ${val('right')}${unit} ${val('bottom')}${unit} ${val('left')}${unit};`;
}

/** Elementor slider objects: { unit, size } -> "52px". */
function sizeVal(obj, fallbackUnit) {
  if (obj == null) return '';
  if (typeof obj === 'number') return `${obj}px`;
  if (typeof obj === 'string') return obj.trim();
  if (typeof obj === 'object' && obj.size !== '' && obj.size != null) {
    return `${obj.size}${obj.unit || fallbackUnit || 'px'}`;
  }
  return '';
}

function styleAttr(parts) {
  const s = parts.filter(Boolean).join('');
  return s ? ` style="${s}"` : '';
}

function heading_tag(size) {
  const t = String(size || 'h2').toLowerCase();
  return /^h[1-6]$/.test(t) ? t : (t === 'div' || t === 'p' || t === 'span' ? t : 'h2');
}

/** Typography settings shared across text widgets. */
function typography(s, prefix) {
  prefix = prefix || 'typography';
  const parts = [];
  const fam = s[`${prefix}_font_family`];
  if (fam) parts.push(`font-family:'${String(fam).replace(/['"]/g, '')}',sans-serif;`);
  const fs = sizeVal(s[`${prefix}_font_size`]);
  if (fs) parts.push(`font-size:${fs};`);
  const fw = s[`${prefix}_font_weight`];
  if (fw && fw !== 'normal') parts.push(`font-weight:${esc(fw)};`);
  const lh = sizeVal(s[`${prefix}_line_height`], 'em');
  if (lh) parts.push(`line-height:${lh};`);
  const ls = sizeVal(s[`${prefix}_letter_spacing`]);
  if (ls) parts.push(`letter-spacing:${ls};`);
  const tt = s[`${prefix}_text_transform`];
  if (tt && tt !== 'none') parts.push(`text-transform:${esc(tt)};`);
  return parts.join('');
}

/** A small emoji/glyph fallback for an Elementor icon object. */
function iconGlyph(icon) {
  const name = (icon && (icon.value || icon.library))
    ? String(icon.value || '')
    : (typeof icon === 'string' ? icon : '');
  const n = name.toLowerCase();
  const map = [
    [/check|tick|success/, '✓'],
    [/star/, '★'],
    [/heart/, '♥'],
    [/phone|call/, '☎'],
    [/envelope|mail|email/, '✉'],
    [/map|location|pin|marker/, '📍'],
    [/user|person|account/, '👤'],
    [/cog|gear|settings|wrench|tools/, '⚙'],
    [/rocket/, '🚀'],
    [/bolt|flash|zap/, '⚡'],
    [/clock|time|history/, '⏱'],
    [/shield|secure|lock/, '🛡'],
    [/chart|graph|analytics/, '📈'],
    [/globe|world|language/, '🌐'],
    [/cart|shop|bag/, '🛒'],
    [/search/, '🔍'],
    [/arrow-right|angle-right|chevron-right/, '→'],
    [/arrow/, '➜'],
    [/cloud/, '☁'],
    [/fire/, '🔥'],
    [/thumbs-up|like/, '👍'],
    [/quote/, '“'],
  ];
  for (const [re, g] of map) if (re.test(n)) return g;
  return '●';
}

/* ----------------------------- widgets ----------------------------- */

function renderWidget(el) {
  const type = el.widgetType || el.elType || 'unknown';
  const s = resolveResponsive((el.settings && typeof el.settings === 'object') ? el.settings : {});
  const align = s.align || s.text_align;
  const alignStyle = align ? `text-align:${esc(align)};` : '';

  switch (type) {
    case 'heading': {
      const tag = heading_tag(s.header_size || s.title_size);
      const st = [
        isColor(s.title_color) ? `color:${esc(s.title_color)};` : '',
        typography(s),
        alignStyle,
        'margin:0 0 .2em;',
      ];
      return `<${tag} class="eai-heading"${styleAttr(st)}>${renderInlineHtml(s.title || '')}</${tag}>`;
    }

    case 'text-editor': {
      const st = [
        isColor(s.text_color) ? `color:${esc(s.text_color)};` : '',
        typography(s),
        alignStyle,
      ];
      const html = sanitizeHtml(s.editor || s.text || '');
      return `<div class="eai-text"${styleAttr(st)}>${html}</div>`;
    }

    case 'button': {
      const label = s.text || 'Button';
      const href = safeUrl(s.link && (s.link.url || s.link) ? (s.link.url || s.link) : '#') || '#';
      const btnSt = [
        isColor(s.background_color) ? `background:${esc(s.background_color)};` : 'background:#4c8bf5;',
        isColor(s.button_text_color) ? `color:${esc(s.button_text_color)};` : 'color:#fff;',
        s.border_radius ? `border-radius:${sizeVal(s.border_radius) || dim4Radius(s.border_radius)};` : 'border-radius:6px;',
        typography(s),
      ];
      const wrapSt = [alignStyle || 'text-align:left;'];
      return `<div class="eai-btn-wrap"${styleAttr(wrapSt)}><a class="eai-btn" href="${esc(href)}"${styleAttr(btnSt)}>${esc(label)}</a></div>`;
    }

    case 'image': {
      const url = safeUrl(s.image && (s.image.url || s.image)) || '';
      const alt = (s.image && s.image.alt) || s.alt || '';
      const objFit = s['object-fit'] || s.object_fit;
      // Honor an explicit width control ({unit:'%',size:N}); the default
      // stays full-width + object-fit cover. inline-block lets the wrapper's
      // text-align position a narrower image.
      const wCss = sizeVal(s.width);
      const imgSt = [
        wCss ? `max-width:100%;width:${wCss};display:inline-block;` : 'max-width:100%;width:100%;display:block;',
        sizeVal(s.height) ? `height:${sizeVal(s.height)};` : '',
        objFit ? `object-fit:${esc(objFit)};` : (sizeVal(s.height) ? 'object-fit:cover;' : ''),
        borderRadiusCss(s.image_border_radius),
        boxShadow(s, 'image_box_shadow'),
      ];
      if (!url) return placeholder('image');
      return `<div class="eai-img"${styleAttr([alignStyle])}><img src="${esc(url)}" alt="${esc(alt)}"${styleAttr(imgSt)}></div>`;
    }

    case 'icon': {
      const st = [isColor(s.primary_color) ? `color:${esc(s.primary_color)};` : '', 'font-size:2rem;', alignStyle];
      return `<div class="eai-icon"${styleAttr(st)}>${esc(iconGlyph(s.selected_icon || s.icon))}</div>`;
    }

    case 'icon-box': {
      const g = esc(iconGlyph(s.selected_icon || s.icon));
      const color = isColor(s.primary_color) ? `color:${esc(s.primary_color)};` : 'color:#4c8bf5;';
      return `<div class="eai-iconbox"${styleAttr([alignStyle || 'text-align:center;'])}>` +
        `<div class="eai-iconbox-ic" style="${color}font-size:2.4rem;">${g}</div>` +
        (s.title_text ? `<div class="eai-iconbox-title">${renderInlineHtml(s.title_text)}</div>` : '') +
        (s.description_text ? `<div class="eai-iconbox-desc">${esc(s.description_text)}</div>` : '') +
        `</div>`;
    }

    case 'image-box': {
      const url = safeUrl(s.image && (s.image.url || s.image));
      const img = url
        ? `<img src="${esc(url)}" alt="${esc((s.image && s.image.alt) || '')}" style="max-width:100%;display:block;margin:0 auto .8rem;">`
        : `<div class="eai-ph-inline">image</div>`;
      return `<div class="eai-imagebox"${styleAttr([alignStyle || 'text-align:center;'])}>${img}` +
        (s.title_text ? `<div class="eai-iconbox-title">${renderInlineHtml(s.title_text)}</div>` : '') +
        (s.description_text ? `<div class="eai-iconbox-desc">${esc(s.description_text)}</div>` : '') +
        `</div>`;
    }

    case 'icon-list': {
      const items = Array.isArray(s.icon_list) ? s.icon_list : [];
      const inline = s.view === 'inline';
      const lis = items.map((it) =>
        `<li class="eai-il-item">` +
        `<span class="eai-il-ic">${esc(iconGlyph(it.selected_icon || it.icon))}</span>` +
        `<span>${esc(it.text || '')}</span></li>`
      ).join('');
      return `<ul class="eai-iconlist${inline ? ' inline' : ''}"${styleAttr([alignStyle])}>${lis || '<li class="eai-il-item"><span class="eai-il-ic">●</span><span>List item</span></li>'}</ul>`;
    }

    case 'counter': {
      const num = `${s.prefix || ''}${s.ending_number != null ? s.ending_number : (s.counter_number || '0')}${s.suffix || ''}`;
      return `<div class="eai-counter"${styleAttr([alignStyle || 'text-align:center;'])}>` +
        `<div class="eai-counter-num">${esc(num)}</div>` +
        (s.title ? `<div class="eai-counter-title">${esc(s.title)}</div>` : '') +
        `</div>`;
    }

    case 'divider': {
      const color = isColor(s.color) ? esc(s.color) : 'currentColor';
      const weight = sizeVal(s.weight) || '1px';
      const line = `border:none;border-top:${weight} ${esc(s.style || 'solid')} ${color};opacity:.4;`;
      if (s.text) {
        // "Line + text" divider — text sits between two line halves.
        return `<div class="eai-divider" style="display:flex;align-items:center;gap:12px;margin:1rem 0;">` +
          `<span style="flex:1;${line}"></span>` +
          `<span>${renderInlineHtml(s.text)}</span>` +
          `<span style="flex:1;${line}"></span></div>`;
      }
      return `<hr class="eai-divider" style="${line}margin:1rem 0;">`;
    }

    case 'spacer': {
      const h = sizeVal(s.space) || '50px';
      return `<div class="eai-spacer" style="height:${h};"></div>`;
    }

    case 'testimonial': {
      const url = safeUrl(s.testimonial_image && (s.testimonial_image.url || s.testimonial_image));
      const avatar = url ? `<img class="eai-tm-avatar" src="${esc(url)}" alt="">` : '';
      return `<figure class="eai-testimonial">` +
        `<blockquote>${esc(s.testimonial_content || '')}</blockquote>` +
        `<figcaption>${avatar}<span>` +
        `<strong>${esc(s.testimonial_name || '')}</strong>` +
        (s.testimonial_job ? `<em>${esc(s.testimonial_job)}</em>` : '') +
        `</span></figcaption></figure>`;
    }

    case 'star-rating': {
      const max = Number(s.rating_scale || 5) || 5;
      const rating = Math.max(0, Math.min(max, Number(s.rating != null ? s.rating : max)));
      let stars = '';
      for (let i = 0; i < max; i++) stars += i < Math.round(rating) ? '★' : '☆';
      const color = isColor(s.stars_color) ? `color:${esc(s.stars_color)};` : 'color:#f0a500;';
      return `<div class="eai-stars" style="${color}font-size:1.3rem;letter-spacing:2px;${alignStyle}">${stars}</div>`;
    }

    case 'alert': {
      const kinds = { info: '#2f6fed', success: '#1e9e5a', warning: '#d99a00', danger: '#d0342c' };
      const c = kinds[s.alert_type] || kinds.info;
      return `<div class="eai-alert" style="border-left:4px solid ${c};background:${c}1a;">` +
        (s.alert_title ? `<div class="eai-alert-title">${esc(s.alert_title)}</div>` : '') +
        (s.alert_description ? `<div class="eai-alert-desc">${esc(s.alert_description)}</div>` : '') +
        `</div>`;
    }

    case 'social-icons': {
      const items = Array.isArray(s.social_icon_list) ? s.social_icon_list : [];
      const chips = (items.length ? items : [{}, {}, {}]).map((it) => {
        const g = it.social_icon ? iconGlyph(it.social_icon) : '◆';
        return `<span class="eai-social-chip">${esc(g)}</span>`;
      }).join('');
      return `<div class="eai-social"${styleAttr([alignStyle])}>${chips}</div>`;
    }

    case 'progress':
    case 'progress-bar': {
      const pct = Math.max(0, Math.min(100, Number(sizeValNum(s.percent)) || 50));
      return `<div class="eai-progress-wrap">` +
        (s.title ? `<div class="eai-progress-title">${esc(s.title)}</div>` : '') +
        `<div class="eai-progress"><div class="eai-progress-fill" style="width:${pct}%;">` +
        `<span>${esc(s.inner_text || pct + '%')}</span></div></div></div>`;
    }

    case 'tabs':
    case 'accordion':
    case 'toggle': {
      const tabs = Array.isArray(s.tabs) ? s.tabs : [];
      const items = tabs.map((t) =>
        `<div class="eai-acc-item"><div class="eai-acc-head">${esc(t.tab_title || t.title || 'Item')}</div>` +
        `<div class="eai-acc-body">${sanitizeHtml(t.tab_content || t.content || '')}</div></div>`
      ).join('');
      return `<div class="eai-accordion">${items || '<div class="eai-acc-item"><div class="eai-acc-head">Section</div></div>'}</div>`;
    }

    case 'hotspot': {
      // Render the base image; hotspot markers are editor/front-end interactive.
      const u = safeUrl(s.image && (s.image.url || s.image));
      if (!u) return placeholder('hotspot');
      return `<div class="eai-img"><img src="${esc(u)}" alt="" style="max-width:100%;width:100%;display:block;"></div>`;
    }

    case 'gallery': // Pro advanced gallery — same preview treatment as the free ones.
    case 'image-carousel':
    case 'image-gallery': {
      const arr = Array.isArray(s.carousel) ? s.carousel
        : (Array.isArray(s.wp_gallery) ? s.wp_gallery
          : (Array.isArray(s.gallery) ? s.gallery : []));
      const imgs = arr.slice(0, 4).map((it) => {
        // Null-safe: /api/preview accepts arbitrary client JSON, and string
        // items are legal model output before validation normalizes them.
        const u = it ? safeUrl(typeof it === 'string' ? it : it.url) : '';
        return u ? `<img src="${esc(u)}" alt="${esc((it && it.alt) || '')}">` : `<div class="eai-ph-inline">image</div>`;
      }).join('');
      return `<div class="eai-gallery">${imgs || '<div class="eai-ph-inline">gallery</div>'}</div>`;
    }

    case 'video': {
      return `<div class="eai-video"><div class="eai-video-play">▶</div><span>Video</span></div>`;
    }

    case 'global': {
      const tid = el.templateID != null ? el.templateID : (s.templateID != null ? s.templateID : '?');
      return `<div class="eai-placeholder">Global widget #${esc(tid)} — renders the site's saved global widget (auto-syncs everywhere)</div>`;
    }

    case 'menu-anchor':
      return ''; // invisible anchor

    case 'google_maps':
      return `<div class="eai-map">🗺 Map</div>`;

    /* ------------------------- Pro widgets ------------------------- */

    case 'nav-menu': {
      const guess = ['Home', 'About', 'Services', 'Contact'];
      const links = guess.map((g) => `<a href="#">${esc(g)}</a>`).join('');
      return `<nav class="eai-nav">${links}</nav>`;
    }

    case 'form': {
      const fields = Array.isArray(s.form_fields) ? s.form_fields : [];
      const rows = (fields.length ? fields : [
        { field_label: 'Name', field_type: 'text' },
        { field_label: 'Email', field_type: 'email' },
        { field_label: 'Message', field_type: 'textarea' },
      ]).map((f) => {
        const label = f.field_label || f.placeholder || 'Field';
        if (f.field_type === 'textarea') {
          return `<label class="eai-field"><span>${esc(label)}</span><textarea rows="3" placeholder="${esc(f.placeholder || '')}"></textarea></label>`;
        }
        return `<label class="eai-field"><span>${esc(label)}</span><input type="${esc(f.field_type || 'text')}" placeholder="${esc(f.placeholder || '')}"></label>`;
      }).join('');
      const btn = esc(s.button_text || 'Submit');
      return `<form class="eai-form" onsubmit="return false">${rows}<button class="eai-btn" type="submit">${btn}</button></form>`;
    }

    case 'slides': {
      const arr = Array.isArray(s.slides) ? s.slides : [];
      const first = arr[0] || {};
      const bg = safeUrl(first.background_image && (first.background_image.url || first.background_image));
      const bgSt = bg ? `background-image:url('${esc(bg)}');background-size:cover;background-position:center;` : 'background:#1c2029;';
      return `<div class="eai-slide" style="${bgSt}">` +
        `<div class="eai-slide-inner">` +
        (first.heading ? `<h3>${esc(first.heading)}</h3>` : '<h3>Slide</h3>') +
        (first.description ? `<p>${esc(first.description)}</p>` : '') +
        (first.button_text ? `<a class="eai-btn" href="#">${esc(first.button_text)}</a>` : '') +
        `</div></div>`;
    }

    case 'testimonial-carousel': {
      const arr = Array.isArray(s.slides) ? s.slides : [];
      const first = arr[0] || {};
      return `<figure class="eai-testimonial"><blockquote>${esc(first.content || 'Testimonial')}</blockquote>` +
        `<figcaption><span><strong>${esc(first.name || '')}</strong>` +
        (first.title ? `<em>${esc(first.title)}</em>` : '') + `</span></figcaption></figure>`;
    }

    case 'media-carousel': {
      const arr = Array.isArray(s.slides) ? s.slides : [];
      const first = arr[0] || {};
      const u = safeUrl(first.image && (first.image.url || first.image));
      return `<div class="eai-gallery">${u ? `<img src="${esc(u)}" alt="">` : '<div class="eai-ph-inline">media</div>'}</div>`;
    }

    case 'price-table': {
      const feats = Array.isArray(s.features_list) ? s.features_list : [];
      const li = (feats.length ? feats : [{ item_text: 'Feature one' }, { item_text: 'Feature two' }])
        .map((f) => `<li>${esc(f.item_text || f.text || '')}</li>`).join('');
      return `<div class="eai-price">` +
        `<div class="eai-price-head">${esc(s.heading || 'Plan')}</div>` +
        (s.sub_heading ? `<div class="eai-price-sub">${esc(s.sub_heading)}</div>` : '') +
        `<div class="eai-price-amt"><sup>${esc(s.currency_symbol || '$')}</sup>${esc(s.price != null ? s.price : '0')}` +
        (s.period ? `<small>/${esc(s.period)}</small>` : '') + `</div>` +
        `<ul class="eai-price-feats">${li}</ul>` +
        `<a class="eai-btn" href="#">${esc(s.button_text || 'Choose plan')}</a>` +
        `</div>`;
    }

    case 'price-list': {
      const items = Array.isArray(s.price_list) ? s.price_list : [];
      const rows = (items.length ? items : [{ title: 'Item', price: '' }]).map((it) =>
        `<li class="eai-plist-row"><span>${esc(it.title || '')}</span><span class="eai-plist-price">${esc(it.price || '')}</span></li>`
      ).join('');
      return `<ul class="eai-plist">${rows}</ul>`;
    }

    case 'call-to-action': {
      const bg = safeUrl(s.bg_image && (s.bg_image.url || s.bg_image));
      const bgSt = bg ? `background-image:url('${esc(bg)}');background-size:cover;background-position:center;` : 'background:#1c2029;';
      return `<div class="eai-cta" style="${bgSt}">` +
        (s.title ? `<h3>${esc(s.title)}</h3>` : '') +
        (s.description ? `<p>${esc(s.description)}</p>` : '') +
        `<a class="eai-btn" href="#">${esc(s.button || 'Learn more')}</a></div>`;
    }

    case 'flip-box': {
      const g = esc(iconGlyph(s.selected_icon || s.icon));
      return `<div class="eai-flip">` +
        `<div class="eai-flip-ic">${g}</div>` +
        (s.title_text_a ? `<div class="eai-iconbox-title">${esc(s.title_text_a)}</div>` : '') +
        (s.description_text_a ? `<div class="eai-iconbox-desc">${esc(s.description_text_a)}</div>` : '') +
        `</div>`;
    }

    case 'animated-headline': {
      const before = s.before_text || '';
      const rotate = s.rotating_text || s.highlighted_text || '';
      const after = s.after_text || '';
      return `<h2 class="eai-heading" style="margin:0 0 .2em;">${renderInlineHtml(before)} <span style="color:#4c8bf5;">${renderInlineHtml(rotate || 'headline')}</span> ${renderInlineHtml(after)}</h2>`;
    }

    case 'countdown':
      return `<div class="eai-countdown"><span>00</span><span>00</span><span>00</span><span>00</span></div>`;

    case 'blockquote':
      return `<figure class="eai-testimonial"><blockquote>${esc(s.blockquote_content || 'Quote')}</blockquote>` +
        (s.author_name ? `<figcaption><span><strong>${esc(s.author_name)}</strong></span></figcaption>` : '') + `</figure>`;

    case 'share-buttons':
      return `<div class="eai-social"><span class="eai-social-chip">f</span><span class="eai-social-chip">t</span><span class="eai-social-chip">in</span></div>`;

    case 'posts':
    case 'portfolio': {
      const cards = [0, 1, 2].map(() =>
        `<div class="eai-post-card"><div class="eai-post-thumb"></div><div class="eai-post-title">Post title</div></div>`
      ).join('');
      return `<div class="eai-posts">${cards}</div>`;
    }

    default:
      return placeholder(type);
  }
}

/** Border-radius may come as a dim4 object. */
function dim4Radius(obj) {
  if (!obj || typeof obj !== 'object') return '6px';
  const u = obj.unit || 'px';
  const v = (k) => (obj[k] === '' || obj[k] == null ? '0' : obj[k]);
  return `${v('top')}${u} ${v('right')}${u} ${v('bottom')}${u} ${v('left')}${u}`;
}

function sizeValNum(obj) {
  if (obj == null) return '';
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return parseFloat(obj);
  if (typeof obj === 'object' && obj.size != null) return obj.size;
  return '';
}

function placeholder(label) {
  return `<div class="eai-placeholder">${esc(label)}</div>`;
}

/* ---- depth-styling helpers: shadows, radius, gradients, overlay ---- */

/** Elementor box-shadow group -> CSS. prefix '' -> box_shadow_box_shadow(_type). */
function boxShadow(s, prefix) {
  prefix = prefix || 'box_shadow';
  if (s[`${prefix}_box_shadow_type`] !== 'yes') return '';
  const b = s[`${prefix}_box_shadow`];
  if (!b || typeof b !== 'object') return '';
  const n = (k) => (b[k] === '' || b[k] == null ? 0 : b[k]);
  const inset = b.position === 'inset' ? 'inset ' : '';
  return `box-shadow:${inset}${n('horizontal')}px ${n('vertical')}px ${n('blur')}px ${n('spread')}px ${esc(b.color || 'rgba(0,0,0,0.15)')};`;
}

/** Elementor border-radius dimension object -> CSS. */
function borderRadiusCss(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const u = obj.unit || 'px';
  if (!['top', 'right', 'bottom', 'left'].some((k) => obj[k] !== '' && obj[k] != null)) return '';
  const v = (k) => (obj[k] === '' || obj[k] == null ? '0' : obj[k]);
  return `border-radius:${v('top')}${u} ${v('right')}${u} ${v('bottom')}${u} ${v('left')}${u};`;
}

/** Background: classic color/image OR gradient. */
function bgLayers(s) {
  if (s.background_background === 'gradient') {
    const c1 = isColor(s.background_color) ? s.background_color : '#000000';
    const c2 = isColor(s.background_color_b) ? s.background_color_b : '#333333';
    if (s.background_gradient_type === 'radial') {
      return `background:radial-gradient(circle at center, ${esc(c1)}, ${esc(c2)});`;
    }
    const ang = sizeValNum(s.background_gradient_angle);
    const a = (ang === '' || ang == null) ? 180 : ang;
    return `background:linear-gradient(${a}deg, ${esc(c1)}, ${esc(c2)});`;
  }
  const parts = [];
  if (isColor(s.background_color)) parts.push(`background-color:${esc(s.background_color)};`);
  const bgImg = safeUrl(s.background_image && (s.background_image.url || s.background_image));
  if (bgImg) {
    const pos = s.background_position ? esc(s.background_position) : 'center center';
    const size = s.background_size ? esc(s.background_size) : 'cover';
    parts.push(`background-image:url('${esc(bgImg)}');background-size:${size};background-position:${pos};background-repeat:no-repeat;`);
  }
  return parts.join('');
}

/** The gradient/classic overlay div that fades a hero photo into the bg. */
function overlayLayer(s, radiusCss) {
  const ob = s.background_overlay_background;
  if (!ob) return '';
  let bg;
  if (ob === 'gradient') {
    const c1 = s.background_overlay_color || 'rgba(0,0,0,0.4)';
    const c2 = s.background_overlay_color_b || 'rgba(0,0,0,0)';
    const ang = sizeValNum(s.background_overlay_gradient_angle);
    const a = (ang === '' || ang == null) ? 180 : ang;
    const s1 = sizeValNum(s.background_overlay_color_stop);
    const s2 = sizeValNum(s.background_overlay_color_b_stop);
    const st1 = (s1 === '' || s1 == null) ? '' : ` ${s1}%`;
    const st2 = (s2 === '' || s2 == null) ? '' : ` ${s2}%`;
    bg = `linear-gradient(${a}deg, ${esc(c1)}${st1}, ${esc(c2)}${st2})`;
  } else {
    bg = esc(s.background_overlay_color || 'rgba(0,0,0,0.4)');
  }
  const op = sizeValNum(s.background_overlay_opacity);
  const opacity = (op === '' || op == null) ? 1 : op;
  return `<div style="position:absolute;inset:0;background:${bg};opacity:${opacity};pointer-events:none;${radiusCss || ''}"></div>`;
}

/** Section min-height (height:"min-height" + custom_height). */
function minHeightCss(s) {
  if (s.height === 'min-height' && s.custom_height) {
    const v = sizeVal(s.custom_height);
    if (v) return `min-height:${v};`;
  }
  return '';
}

/** z-index (implies positioning) for floating/overlap panels. */
function zIndexCss(s) {
  return (s.z_index !== '' && s.z_index != null) ? `position:relative;z-index:${parseInt(s.z_index, 10) || 0};` : '';
}

/* --------------------------- containers --------------------------- */

function renderColumn(col) {
  const s = resolveResponsive((col.settings && typeof col.settings === 'object') ? col.settings : {});
  const basis = s._column_size ? `flex:0 0 ${s._column_size}%;max-width:${s._column_size}%;` : 'flex:1;';
  const posMap = { top: 'flex-start', middle: 'center', center: 'center', bottom: 'flex-end' };
  const justify = s.content_position ? `justify-content:${posMap[s.content_position] || 'flex-start'};` : '';
  const radius = borderRadiusCss(s.border_radius);
  const st = [
    basis,
    'display:flex;flex-direction:column;',
    justify,
    bgLayers(s),
    dim4(s.padding, 'padding'),
    dim4(s.margin, 'margin'), // supports negative margins for floating/overlap cards
    radius,
    boxShadow(s),
    (s.border_border === 'solid')
      ? `border:${sizeVal(s.border_width) || '1px'} solid ${esc(s.border_color || 'rgba(0,0,0,.1)')};`
      : '',
    zIndexCss(s),
    radius ? 'overflow:hidden;' : '', // clip child images to the card's rounded corners (shadow is unaffected)
    'min-width:0;box-sizing:border-box;',
  ];
  const inner = renderChildren(col.elements || []);
  return `<div class="eai-col"${styleAttr(st)}>${inner}</div>`;
}

/** Elementor flex container (elType:"container") — the primary layout model. */
function renderContainer(con) {
  const s = resolveResponsive((con.settings && typeof con.settings === 'object') ? con.settings : {});
  const radius = borderRadiusCss(s.border_radius);
  const dir = s.flex_direction || 'column';
  const gapObj = s.flex_gap;
  let gapCss = '';
  if (gapObj && typeof gapObj === 'object') {
    const unit = gapObj.unit || 'px';
    const col = gapObj.column != null && gapObj.column !== '' ? gapObj.column : (gapObj.size != null ? gapObj.size : '');
    const row = gapObj.row != null && gapObj.row !== '' ? gapObj.row : col;
    if (col !== '' || row !== '') gapCss = `gap:${row || 0}${unit} ${col || 0}${unit};`;
  }
  const widthCss = (() => {
    // Child containers size themselves via `width` ({unit:'%',size:N}).
    const w = sizeVal(s.width);
    return w ? `flex:0 0 ${w};max-width:${w};` : (con.isInner ? 'flex:1;' : '');
  })();
  const st = [
    'display:flex;',
    `flex-direction:${esc(dir)};`,
    s.flex_wrap === 'wrap' ? 'flex-wrap:wrap;' : '',
    s.flex_justify_content ? `justify-content:${esc(s.flex_justify_content)};` : '',
    s.flex_align_items ? `align-items:${esc(s.flex_align_items)};` : '',
    gapCss || 'gap:20px;',
    widthCss,
    bgLayers(s),
    dim4(s.padding, 'padding') || (con.isInner ? '' : 'padding:48px 24px;'),
    dim4(s.margin, 'margin'),
    radius,
    boxShadow(s),
    (s.border_border === 'solid')
      ? `border:${sizeVal(s.border_width) || '1px'} solid ${esc(s.border_color || 'rgba(0,0,0,.1)')};`
      : '',
    s.min_height ? `min-height:${sizeVal(s.min_height)};` : '',
    'position:relative;box-sizing:border-box;min-width:0;',
    zIndexCss(s),
    radius ? 'overflow:hidden;' : '',
  ];
  const overlay = overlayLayer(s, radius);
  // Boxed top-level containers constrain their content like Elementor does.
  const boxed = !con.isInner && s.content_width !== 'full';
  const inner = renderChildren(con.elements || []);
  const body = boxed
    ? `<div style="max-width:1140px;margin:0 auto;width:100%;display:flex;flex-direction:${esc(dir)};${gapCss || 'gap:20px;'}${s.flex_wrap === 'wrap' ? 'flex-wrap:wrap;' : ''}${s.flex_justify_content ? `justify-content:${esc(s.flex_justify_content)};` : ''}${s.flex_align_items ? `align-items:${esc(s.flex_align_items)};` : ''}position:relative;z-index:1;">${inner}</div>`
    : `<div style="display:contents;">${inner}</div>`;
  return `<div class="eai-container"${styleAttr(st)}>${overlay}${body}</div>`;
}

function renderSection(sec) {
  const s = resolveResponsive((sec.settings && typeof sec.settings === 'object') ? sec.settings : {});
  const radius = borderRadiusCss(s.border_radius);
  const st = [
    bgLayers(s),
    dim4(s.padding, 'padding') || 'padding:48px 24px;',
    isColor(s.color) ? `color:${esc(s.color)};` : '',
    radius,
    boxShadow(s),
    minHeightCss(s),
    dim4(s.margin, 'margin'),
    'position:relative;', // anchor for the overlay layer
    zIndexCss(s),
  ];
  const overlay = overlayLayer(s, radius);
  const colPosMap = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
  const alignRow = s.column_position ? `align-items:${colPosMap[s.column_position] || 'stretch'};` : '';
  const boxed = s.content_width !== 'full';
  const cols = (sec.elements || []).filter((el) => el && typeof el === 'object').map(renderColumn).join('');
  const rowMax = boxed ? 'max-width:1140px;' : 'max-width:100%;';
  return `<section class="eai-section"${styleAttr(st)}>${overlay}` +
    `<div class="eai-row" style="${rowMax}${alignRow}position:relative;z-index:1;">${cols}</div></section>`;
}

/** Children can be containers, inner sections, columns, or widgets. */
function renderChildren(elements) {
  if (!Array.isArray(elements)) return '';
  return elements
    .filter((el) => el && typeof el === 'object' && !hiddenOnDevice(el))
    .map((el) => {
    if (el.elType === 'container') return renderContainer(el);
    if (el.elType === 'column') return renderColumn(el);
    if (el.elType === 'section') return renderSection(el);
    // Treat everything else as a widget.
    if (el.elType === 'widget' || el.widgetType) return `<div class="eai-widget">${renderWidget(el)}</div>`;
    if (Array.isArray(el.elements) && el.elements.length) {
      return `<div class="eai-container">${renderChildren(el.elements)}</div>`;
    }
    return placeholder(el.elType || el.widgetType || 'element');
  }).join('');
}

/* ------------------------------ page ------------------------------ */

function renderPage(pageJson, opts = {}) {
  DEVICE = ['desktop', 'tablet', 'mobile'].includes(opts.device) ? opts.device : 'desktop';
  const interactive = opts.interactive === true;
  const page = (pageJson && typeof pageJson === 'object') ? pageJson : {};
  const content = Array.isArray(page.content)
    ? page.content.filter((el) => el && typeof el === 'object' && !hiddenOnDevice(el))
    : [];
  const title = esc(page.title || 'Preview');
  const customCss = typeof page.custom_css === 'string' ? sanitizeCss(page.custom_css) : '';

  let body;
  if (content.length === 0) {
    body = `<div class="eai-empty">No content to preview.</div>`;
  } else {
    body = content.map((el, i) => {
      let html;
      if (el.elType === 'container') html = renderContainer(el);
      else if (el.elType === 'section') html = renderSection(el);
      else if (el.elType === 'column') html = `<section class="eai-section"><div class="eai-row">${renderColumn(el)}</div></section>`;
      else if (el.widgetType || el.elType === 'widget') html = `<section class="eai-section"><div class="eai-row"><div class="eai-col"><div class="eai-widget">${renderWidget(el)}</div></div></div></section>`;
      else if (Array.isArray(el.elements)) html = `<section class="eai-section"><div class="eai-row">${renderChildren(el.elements)}</div></section>`;
      else html = '';
      // Click-to-select wrapper: the parent app maps the index back to
      // pageJson.content[index] to scope a refine to that section.
      return interactive ? `<div class="eai-selwrap" data-eai-index="${i}">${html}</div>` : html;
    }).join('');
  }

  const interactiveExtras = interactive
    ? `<style>
.eai-selwrap{position:relative;cursor:pointer;}
.eai-selwrap:hover{outline:3px solid #4c8bf5;outline-offset:-3px;}
.eai-selwrap:hover::after{content:'Click to refine this section';position:absolute;top:8px;right:8px;
  background:#4c8bf5;color:#fff;font:600 12px/1 -apple-system,Segoe UI,sans-serif;
  padding:6px 10px;border-radius:6px;z-index:99;}
</style>
<script>
document.querySelectorAll('[data-eai-index]').forEach(function (el) {
  el.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: 'eai-select-section', index: Number(el.getAttribute('data-eai-index')) }, '*');
  });
});
</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${BASE_CSS}
${customCss}
</style>
</head>
<body>
<div class="eai-preview">${body}</div>
${interactiveExtras}
</body>
</html>`;
}

/** Keep custom CSS but drop anything that could break out of the preview. */
function sanitizeCss(css) {
  return String(css || '')
    .replace(/<\s*\/?\s*(script|style)[^>]*>/gi, '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript:/gi, '')
    .slice(0, 60 * 1024);
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color:#1a1d24;background:#f4f5f7;line-height:1.55;-webkit-font-smoothing:antialiased;}
img{max-width:100%;}
a{color:inherit;text-decoration:none;}
.eai-preview{width:100%;}
.eai-section{width:100%;}
.eai-row{margin:0 auto;display:flex;flex-wrap:wrap;gap:24px;align-items:stretch;width:100%;}
.eai-col{gap:14px;position:relative;z-index:1;}
.eai-widget{position:relative;z-index:1;}
.eai-heading{font-weight:700;line-height:1.2;}
.eai-text{}
.eai-btn-wrap{}
.eai-btn{display:inline-block;padding:12px 26px;font-weight:600;cursor:pointer;border:none;
  border-radius:6px;background:#4c8bf5;color:#fff;text-align:center;}
.eai-img img{border-radius:4px;}
.eai-iconbox,.eai-imagebox{padding:8px 0;}
.eai-iconbox-title{font-weight:700;font-size:1.15rem;margin:.4rem 0 .3rem;}
.eai-iconbox-desc{opacity:.8;font-size:.95rem;}
.eai-iconlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem;}
.eai-iconlist.inline{flex-direction:row;flex-wrap:wrap;gap:1rem;}
.eai-il-item{display:flex;align-items:center;gap:.5rem;}
.eai-il-ic{color:#4c8bf5;}
.eai-counter-num{font-size:2.6rem;font-weight:800;line-height:1;}
.eai-counter-title{opacity:.8;margin-top:.3rem;}
.eai-testimonial{margin:0;padding:1.2rem;border:1px solid rgba(0,0,0,.08);border-radius:10px;background:rgba(255,255,255,.5);}
.eai-testimonial blockquote{margin:0 0 .8rem;font-style:italic;}
.eai-testimonial figcaption{display:flex;align-items:center;gap:.7rem;}
.eai-testimonial figcaption em{display:block;opacity:.7;font-size:.85rem;font-style:normal;}
.eai-tm-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;}
.eai-alert{padding:.9rem 1.1rem;border-radius:6px;margin:.3rem 0;}
.eai-alert-title{font-weight:700;margin-bottom:.2rem;}
.eai-social{display:flex;gap:.5rem;}
.eai-social-chip{width:38px;height:38px;border-radius:50%;background:#4c8bf5;color:#fff;
  display:inline-flex;align-items:center;justify-content:center;font-size:1rem;}
.eai-progress-wrap{margin:.4rem 0;}
.eai-progress-title{font-weight:600;margin-bottom:.3rem;}
.eai-progress{background:rgba(0,0,0,.1);border-radius:20px;overflow:hidden;height:26px;}
.eai-progress-fill{background:#4c8bf5;color:#fff;height:100%;display:flex;align-items:center;
  justify-content:flex-end;padding:0 10px;font-size:.8rem;border-radius:20px;min-width:2rem;}
.eai-accordion{border:1px solid rgba(0,0,0,.1);border-radius:8px;overflow:hidden;}
.eai-acc-item+.eai-acc-item{border-top:1px solid rgba(0,0,0,.1);}
.eai-acc-head{padding:.9rem 1.1rem;font-weight:600;background:rgba(0,0,0,.03);}
.eai-acc-body{padding:.9rem 1.1rem;}
.eai-gallery{display:flex;gap:8px;flex-wrap:wrap;}
.eai-gallery img{width:calc(50% - 4px);height:120px;object-fit:cover;border-radius:6px;}
.eai-ph-inline{background:rgba(0,0,0,.06);border:1px dashed rgba(0,0,0,.2);border-radius:6px;
  padding:2rem;text-align:center;color:#888;flex:1;min-width:120px;}
.eai-video{background:#111;color:#fff;border-radius:8px;height:200px;display:flex;
  align-items:center;justify-content:center;gap:.6rem;}
.eai-video-play{width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.2);
  display:flex;align-items:center;justify-content:center;}
.eai-map{background:#e5e7eb;border-radius:8px;height:180px;display:flex;align-items:center;
  justify-content:center;color:#666;}
.eai-nav{display:flex;gap:1.4rem;flex-wrap:wrap;font-weight:600;}
.eai-nav a{opacity:.85;}
.eai-form{display:flex;flex-direction:column;gap:.8rem;max-width:520px;}
.eai-field{display:flex;flex-direction:column;gap:.3rem;font-size:.9rem;font-weight:600;}
.eai-field input,.eai-field textarea{padding:.6rem .7rem;border:1px solid rgba(0,0,0,.2);
  border-radius:6px;font:inherit;font-weight:400;}
.eai-slide{min-height:260px;border-radius:10px;display:flex;align-items:center;
  padding:2rem;color:#fff;position:relative;overflow:hidden;}
.eai-slide::before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.35);}
.eai-slide-inner{position:relative;z-index:1;}
.eai-slide-inner h3{margin:0 0 .5rem;font-size:1.8rem;}
.eai-price{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:1.6rem;text-align:center;
  background:#fff;}
.eai-price-head{font-size:1.3rem;font-weight:700;}
.eai-price-sub{opacity:.7;margin-bottom:.6rem;}
.eai-price-amt{font-size:2.6rem;font-weight:800;margin:.4rem 0 1rem;}
.eai-price-amt sup{font-size:1.1rem;vertical-align:super;}
.eai-price-amt small{font-size:.9rem;opacity:.6;font-weight:500;}
.eai-price-feats{list-style:none;padding:0;margin:0 0 1.2rem;display:flex;flex-direction:column;gap:.5rem;}
.eai-price-feats li::before{content:'✓ ';color:#1e9e5a;}
.eai-plist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.6rem;}
.eai-plist-row{display:flex;justify-content:space-between;border-bottom:1px dashed rgba(0,0,0,.15);
  padding-bottom:.4rem;}
.eai-plist-price{font-weight:700;}
.eai-cta{border-radius:12px;padding:2.4rem;text-align:center;color:#fff;position:relative;overflow:hidden;}
.eai-cta::before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.35);}
.eai-cta>*{position:relative;z-index:1;}
.eai-cta h3{margin:0 0 .6rem;font-size:1.8rem;}
.eai-flip{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:2rem;text-align:center;
  background:#fff;}
.eai-flip-ic{font-size:2.4rem;color:#4c8bf5;margin-bottom:.6rem;}
.eai-countdown{display:flex;gap:.6rem;}
.eai-countdown span{background:#1a1d24;color:#fff;padding:.8rem 1rem;border-radius:6px;
  font-size:1.4rem;font-weight:700;min-width:3rem;text-align:center;}
.eai-posts{display:flex;gap:1rem;flex-wrap:wrap;}
.eai-post-card{flex:1;min-width:160px;border:1px solid rgba(0,0,0,.1);border-radius:8px;overflow:hidden;}
.eai-post-thumb{height:120px;background:rgba(0,0,0,.08);}
.eai-post-title{padding:.7rem;font-weight:600;}
.eai-placeholder{background:rgba(0,0,0,.05);border:1px dashed rgba(0,0,0,.25);border-radius:6px;
  padding:1rem;text-align:center;color:#888;font-size:.85rem;}
.eai-empty{padding:4rem;text-align:center;color:#888;}
@media (max-width:768px){
  .eai-col{flex:1 1 100% !important;max-width:100% !important;}
  .eai-row{gap:16px;}
}
`;

module.exports = { renderPage };
