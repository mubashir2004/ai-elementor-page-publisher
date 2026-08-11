'use strict';

/**
 * Tests for backend/historyStore.js — append/list/get + the 20-version cap.
 * Points the store at a fresh OS temp dir via EAI_HISTORY_DIR (read at call
 * time) and uses a plain creds stub; no WordPress or network involved.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eai-history-test-'));
process.env.EAI_HISTORY_DIR = tmpRoot;

const historyStore = require('../historyStore');

const creds = {
  wpUrl: 'https://Example-Site.com/some/path',
  wpUser: 'stub',
  wpAppPassword: 'stub stub stub',
};

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

test('appendVersion + listVersions: entries round-trip, list omits pageJson, newest first', async () => {
  const pageId = 101;
  const a = await historyStore.appendVersion(creds, pageId, {
    source: 'generate',
    title: 'Landing A',
    summary: 'first version',
    pageJson: { title: 'Landing A', page_settings: {}, content: [{ elType: 'container' }], custom_css: '' },
  });
  const b = await historyStore.appendVersion(creds, pageId, {
    source: 'refine',
    title: 'Landing B',
    summary: 'second version',
    pageJson: { title: 'Landing B', page_settings: {}, content: [{ elType: 'container' }], custom_css: '' },
  });

  // Store fills versionId/ts when not supplied.
  assert.ok(a.versionId && typeof a.versionId === 'string');
  assert.ok(b.versionId && b.versionId !== a.versionId);
  assert.ok(!Number.isNaN(Date.parse(a.ts)), 'ts is a valid ISO date');

  const list = await historyStore.listVersions(creds, pageId);
  assert.strictEqual(list.length, 2);
  // Newest first, and never carrying the heavy pageJson payload.
  assert.strictEqual(list[0].versionId, b.versionId);
  assert.strictEqual(list[1].versionId, a.versionId);
  for (const v of list) {
    assert.strictEqual('pageJson' in v, false, 'listVersions must omit pageJson');
  }
  assert.strictEqual(list[0].source, 'refine');
  assert.strictEqual(list[0].summary, 'second version');

  // getVersion returns the FULL entry including pageJson.
  const full = await historyStore.getVersion(creds, pageId, a.versionId);
  assert.ok(full);
  assert.strictEqual(full.title, 'Landing A');
  assert.deepStrictEqual(full.pageJson.content, [{ elType: 'container' }]);

  // Unknown version -> null.
  assert.strictEqual(await historyStore.getVersion(creds, pageId, 'nope1234'), null);

  // The file landed under a sanitized siteKey directory.
  const siteDir = path.join(tmpRoot, 'example-site.com');
  assert.ok(fs.existsSync(path.join(siteDir, '101.json')), 'expected data/history/<siteKey>/<pageId>.json');
});

test('appendVersion caps history at the last 20 versions', async () => {
  const pageId = 202;
  for (let i = 1; i <= 25; i++) {
    await historyStore.appendVersion(creds, pageId, {
      source: 'generate',
      title: `v${i}`,
      summary: `version ${i}`,
      pageJson: { title: `v${i}`, page_settings: {}, content: [], custom_css: '' },
    });
  }

  const list = await historyStore.listVersions(creds, pageId);
  assert.strictEqual(list.length, 20, 'only the last 20 versions are kept');
  // Newest first: the head is v25, the tail (oldest surviving) is v6.
  assert.strictEqual(list[0].summary, 'version 25');
  assert.strictEqual(list[19].summary, 'version 6');
});

test('missing and corrupt history files behave like an empty history', async () => {
  // Missing file.
  assert.deepStrictEqual(await historyStore.listVersions(creds, 999), []);
  assert.strictEqual(await historyStore.getVersion(creds, 999, 'abc'), null);

  // Corrupt file: garbage on disk must not throw, and appending must recover.
  const pageId = 303;
  const file = path.join(tmpRoot, 'example-site.com', '303.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json at all', 'utf8');

  assert.deepStrictEqual(await historyStore.listVersions(creds, pageId), []);
  const v = await historyStore.appendVersion(creds, pageId, {
    source: 'backup',
    title: 'recovered',
    summary: 'after corruption',
    pageJson: { title: 'recovered', page_settings: {}, content: [], custom_css: '' },
  });
  const list = await historyStore.listVersions(creds, pageId);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].versionId, v.versionId);
});
