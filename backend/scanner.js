/**
 * ============================================================
 * FILE: backend/scanner.js
 *
 * Playwright site scanner — loads a live website, captures
 * viewport-sized screenshots (which feed the reference-image
 * pipeline) and extracts real design hints (fonts + dominant
 * colors) from computed styles.
 *
 * scanSite(url, { maxShots }) ->
 *   { images: [{ base64, mediaType, name }], hints: { colors, fonts, title } }
 *
 * SSRF guard: only public http(s) hosts are allowed.
 * ============================================================
 */

'use strict';

const VIEWPORT = { width: 1360, height: 900 };

/** Reject non-http(s) and private/loopback targets. */
function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch (_) {
    throw httpError(400, 'bad_url', 'Enter a full URL like https://example.com');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError(400, 'bad_url', 'Only http(s) URLs can be scanned.');
  }
  const host = u.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/, /^127\./, /^0\./, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/, /^\[?fc/, /^\[?fe80/,
  ];
  if (privatePatterns.some((re) => re.test(host))) {
    throw httpError(400, 'bad_url', 'Local/private addresses cannot be scanned.');
  }
  return u.toString();
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Scroll to the bottom in steps so lazy-loaded content renders. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
      // hard stop after 12s of scrolling no matter what
      setTimeout(() => { clearInterval(timer); resolve(); }, 25000);
    });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}


/** Force lazy images/backgrounds to load and neutralize scroll animations. */
async function forceFullRender(page) {
  await page.evaluate(() => {
    // Lazy images -> eager, and common lazyload data-attrs -> real src.
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
    document.querySelectorAll('iframe[loading="lazy"]').forEach((f) => { f.loading = 'eager'; });
    document.querySelectorAll('img[data-src]').forEach((i) => { if (!i.src || i.src.startsWith('data:')) i.src = i.dataset.src; });
    document.querySelectorAll('img[data-lazy-src]').forEach((i) => { i.src = i.dataset.lazySrc; });
    document.querySelectorAll('[data-bg]').forEach((el) => { el.style.backgroundImage = 'url(' + el.dataset.bg + ')'; });
  });
  // Scroll-triggered entrance animations leave un-scrolled sections INVISIBLE
  // in a full-page screenshot — freeze everything visible before capture.
  await page.addStyleTag({ content:
    '*,*::before,*::after{animation:none!important;transition:none!important;}' +
    '.elementor-invisible,[data-aos],.animated,.wow{opacity:1!important;visibility:visible!important;transform:none!important;}' +
    '[style*="opacity: 0"]{opacity:1!important;}'
  }).catch(() => {});
  // Wait for every image to finish (or 8s, whichever first).
  await Promise.race([
    page.evaluate(() => Promise.all(
      Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
      }))
    )),
    page.waitForTimeout(8000),
  ]);
  // IFRAME embeds (Google Maps!) draw their tiles asynchronously — visit
  // each one so it enters the viewport, then give the network time to go
  // quiet before capturing.
  try {
    const frames = await page.evaluate(() => Array.from(document.querySelectorAll('iframe'))
      .slice(0, 6)
      .map((f) => f.getBoundingClientRect().top + window.scrollY));
    for (const y of frames) {
      await page.evaluate((yy) => window.scrollTo(0, Math.max(0, yy - 200)), y);
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch (_) { /* best-effort */ }
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch (_) { /* busy sites never go idle — proceed */ }
  await page.waitForTimeout(1500);
}

/** Extract fonts + dominant colors + title from computed styles. */
async function extractHints(page) {
  return page.evaluate(() => {
    const fonts = new Set();
    for (const sel of ['body', 'h1', 'h2', 'h3', 'p', 'a', 'button']) {
      document.querySelectorAll(sel).forEach((el, i) => {
        if (i > 3) return;
        const fam = getComputedStyle(el).fontFamily;
        if (fam) fonts.add(fam.split(',')[0].replace(/['"]/g, '').trim());
      });
    }
    const counts = new Map();
    const els = Array.from(document.querySelectorAll('*')).slice(0, 400);
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const c of [cs.backgroundColor, cs.color]) {
        if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') continue;
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    const colors = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c);
    return { fonts: [...fonts].slice(0, 6), colors, title: document.title || '' };
  });
}

/**
 * Scan a site. Requires the `playwright` package + chromium browser
 * (npx playwright install chromium). Errors carry status/code so the
 * API route can relay them cleanly.
 */
async function scanSite(url, { maxShots = 4 } = {}) {
  const safeUrl = assertSafeUrl(url);

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    throw httpError(503, 'scanner_unavailable', 'Site scanner is not installed on this machine.');
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      // Software WebGL: JS-rendered maps (Google Maps) draw blank without it.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
  } catch (err) {
    throw httpError(503, 'scanner_unavailable',
      'Chromium is not installed for the scanner (run: npx playwright install chromium). ' + err.message);
  }

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    try {
      await page.goto(safeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (_) {
      // Slow/busy sites: settle for DOM ready.
      await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await autoScroll(page);
    await forceFullRender(page);

    // LIVE viewport-stepping capture: scroll screen by screen and shoot the
    // REAL rendered viewport each time. Unlike a stitched fullPage shot,
    // dynamic content (JS maps, embeds, canvases) is captured exactly as a
    // visitor sees it. Covers the ENTIRE page height (header to footer).
    const totalH = await page.evaluate(() => Math.max(
      document.body.scrollHeight, document.documentElement.scrollHeight,
    ));
    const MAX_SEGMENTS = 24;
    const steps = Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(totalH / VIEWPORT.height)));
    const images = [];
    for (let i = 0; i < steps; i++) {
      const y = Math.min(i * VIEWPORT.height, Math.max(0, totalH - VIEWPORT.height));
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      // Dwell so lazy/animated/tile-based content in THIS viewport finishes.
      await page.waitForTimeout(i === 0 ? 600 : 900);
      const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
      images.push({
        base64: buf.toString('base64'),
        mediaType: 'image/jpeg',
        name: `scan — section ${i + 1} of ${steps}`,
      });
    }

    let hints = { fonts: [], colors: [], title: '' };
    try {
      hints = await extractHints(page);
    } catch (_) { /* hints are best-effort */ }

    return { images, hints };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scanSite };
