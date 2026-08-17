/**
 * ============================================================
 * FILE: frontend/src/components/ConnectScreen.jsx
 * OWNER: Person 3 (Connect Screen)
 *
 * Credential entry + real connection test with a live checklist.
 * On all-green (plugin + Elementor present), unlocks the Build screen.
 * ============================================================
 */

import { useState } from 'react';
import { testConnection, testGeminiKey } from '../api';

const MODELS = ['claude-opus-4-8']; // fixed internally — Opus 4.8 is the design model

const CHECKS = [
  ['wpReachable', 'Site reachable'],
  ['authValid', 'Login valid'],
  ['pluginInstalled', 'Connector plugin installed'],
  ['elementorActive', 'Elementor active'],
];

const FIXES = {
  wpReachable: 'Check the URL. It must be a live WordPress site over https://',
  authValid: 'Username or Application Password rejected — regenerate it under Users → Profile.',
  pluginInstalled: 'Install & activate eai-connector.php on the site.',
  elementorActive: 'Activate the Elementor plugin on the site.',
};

export default function ConnectScreen({ onConnected }) {
  const [form, setForm] = useState({
    wpUrl: '', wpUser: '', wpAppPassword: '', claudeKey: '', claudeModel: MODELS[0],
  });
  const [show, setShow] = useState({ pw: false, key: false });
  const [claudeMode, setClaudeMode] = useState('api'); // 'api' | 'cli'
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Post-test options, lifted to App on Continue.
  const [allowPro, setAllowPro] = useState(false);
  const [unsplashKey, setUnsplashKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [brandContext, setBrandContext] = useState('');
  // Gemini key test: idle | testing | {ok, preview?, error?}
  const [geminiTest, setGeminiTest] = useState(null);

  async function handleGeminiTest() {
    if (!geminiKey.trim() || geminiTest === 'testing') return;
    setGeminiTest('testing');
    try {
      const r = await testGeminiKey(geminiKey.trim());
      setGeminiTest(r);
    } catch (e) {
      setGeminiTest({ ok: false, error: e.message || 'Test failed.' });
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const allGreen = result &&
    result.wpReachable && result.authValid && result.pluginInstalled && result.elementorActive &&
    (claudeMode !== 'cli' || result.claudeCli);

  async function handleTest() {
    setErr('');
    setResult(null);
    if (!/^https:\/\//i.test(form.wpUrl.trim())) {
      setErr('Site URL must start with https://');
      return;
    }
    if (!form.wpUser || !form.wpAppPassword || (claudeMode === 'api' && !form.claudeKey)) {
      setErr('All fields are required.');
      return;
    }
    setBusy(true);
    try {
      const r = await testConnection({ ...form, claudeMode, unsplashKey, geminiKey, brandContext });
      setResult(r);
      // Default the widget-mode toggle to whatever the site supports.
      setAllowPro(!!r.elementorPro);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function handleContinue() {
    onConnected({
      ...form,
      claudeMode,
      elementorPro: !!(result && result.elementorPro),
      allowPro,
      unsplashKey,
      geminiKey,
      brandContext,
    });
  }

  return (
    <div className="card">
      <h1 className="title">Connect your site</h1>
      <p className="subtitle">Credentials are held only in your server session. Nothing is stored to disk.</p>

      <label className="label">WordPress site URL</label>
      <input className="input" placeholder="https://yoursite.com" value={form.wpUrl} onChange={set('wpUrl')} />

      <label className="label">WordPress username</label>
      <input className="input" placeholder="admin" value={form.wpUser} onChange={set('wpUser')} autoComplete="username" />

      <label className="label">Application password</label>
      <div className="input-row">
        <input
          className="input"
          type={show.pw ? 'text' : 'password'}
          placeholder="xxxx xxxx xxxx xxxx"
          value={form.wpAppPassword}
          onChange={set('wpAppPassword')}
          autoComplete="current-password"
        />
        <button type="button" className="ghost" onClick={() => setShow((s) => ({ ...s, pw: !s.pw }))}>
          {show.pw ? 'Hide' : 'Show'}
        </button>
      </div>
      <p className="hint">WordPress Admin → Users → Profile → Application Passwords → add new.</p>

      <label className="label">Claude access</label>
      <div className="seg">
        <button
          type="button"
          className={claudeMode === 'api' ? 'seg-btn active' : 'seg-btn'}
          onClick={() => setClaudeMode('api')}
        >
          API key
        </button>
        <button
          type="button"
          className={claudeMode === 'cli' ? 'seg-btn active' : 'seg-btn'}
          onClick={() => setClaudeMode('cli')}
        >
          Local Claude CLI
        </button>
      </div>

      {claudeMode === 'api' ? (
        <>
          <label className="label">Claude API key</label>
          <div className="input-row">
            <input
              className="input"
              type={show.key ? 'text' : 'password'}
              placeholder="sk-ant-..."
              value={form.claudeKey}
              onChange={set('claudeKey')}
            />
            <button type="button" className="ghost" onClick={() => setShow((s) => ({ ...s, key: !s.key }))}>
              {show.key ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="hint">Get one at console.anthropic.com. Used only server-side.</p>
        </>
      ) : (
        <p className="hint">
          Uses the Claude Code CLI installed on THIS machine and its own login — no API key
          needed. Install once with <code>npm install -g @anthropic-ai/claude-code</code>, then
          run <code>claude</code> in a terminal and sign in. The connection test checks it works.
        </p>
      )}

      {/* Model is fixed internally to Claude Opus 4.8 — the strongest design
          model. No user-facing selector (per product decision). */}

      {err && <div className="alert-error">{err}</div>}

      <button className="primary" onClick={handleTest} disabled={busy}>
        {busy ? 'Testing…' : 'Test connection'}
      </button>

      {result && (
        <div className="checklist">
          {CHECKS.map(([key, label]) => {
            const ok = result[key];
            return (
              <div key={key} className={`check ${ok ? 'ok' : 'bad'}`}>
                <span className="dot">{ok ? '✓' : '✕'}</span>
                <span className="check-label">{label}</span>
                {key === 'elementorActive' && ok && result.elementorPro && <span className="badge">Pro</span>}
                {key === 'elementorActive' && ok && result.elementorVersion && (
                  <span className="ver">v{result.elementorVersion}</span>
                )}
                {!ok && <span className="fix">{(result.messages && result.messages[key]) || FIXES[key]}</span>}
              </div>
            );
          })}
          {claudeMode === 'cli' && 'claudeCli' in result && (
            <div className={`check ${result.claudeCli ? 'ok' : 'bad'}`}>
              <span className="dot">{result.claudeCli ? '✓' : '✕'}</span>
              <span className="check-label">Claude CLI ready</span>
              {result.claudeCli && result.claudeCliVersion && (
                <span className="ver">{result.claudeCliVersion}</span>
              )}
              {!result.claudeCli && (
                <span className="fix">{(result.messages && result.messages.claudeCli) || 'Install Claude Code and sign in, then re-test.'}</span>
              )}
            </div>
          )}
        </div>
      )}

      {allGreen && (
        <div className="post-test">
          <label className="label">Widget mode</label>
          <div className="seg">
            <button
              type="button"
              className={!allowPro ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setAllowPro(false)}
            >
              Free widgets
            </button>
            <button
              type="button"
              className={allowPro ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setAllowPro(true)}
              disabled={!result.elementorPro}
              title={result.elementorPro ? '' : 'Elementor Pro not detected on this site'}
            >
              Free + Pro widgets
            </button>
          </div>
          <p className="hint">
            {result.elementorPro
              ? 'Pro widgets (forms, nav menu, price tables, carousels…) are available on this site.'
              : 'Elementor Pro was not detected — only free widgets can be used.'}
          </p>

          <label className="label">Gemini API key (optional)</label>
          <div className="input-row">
            <input
              className="input"
              type={show.gemini ? 'text' : 'password'}
              placeholder="Enables AI-generated images (choose 'AI-generated' on Build)"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
            />
            <button type="button" className="ghost" onClick={() => setShow((s) => ({ ...s, gemini: !s.gemini }))}>
              {show.gemini ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!geminiKey.trim() || geminiTest === 'testing'}
              onClick={handleGeminiTest}
            >
              {geminiTest === 'testing' ? 'Generating…' : 'Test'}
            </button>
          </div>
          {geminiTest && geminiTest !== 'testing' && (
            geminiTest.ok ? (
              <p className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img
                  src={geminiTest.preview}
                  alt="Gemini test image"
                  style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }}
                />
                <span>✅ Key works — this image was just generated by Gemini. AI image generation is ready.</span>
              </p>
            ) : (
              <p className="hint" style={{ color: '#f87171' }}>
                ❌ {geminiTest.error || 'The key did not produce an image.'}
              </p>
            )
          )}
          <p className="hint">Get one at aistudio.google.com. Generates images with Gemini instead of stock photos. Used only server-side. Click Test to generate a sample image and confirm the key works.</p>

          <label className="label">Brand context / guardrails (optional)</label>
          <textarea
            className="input textarea"
            rows={3}
            placeholder="e.g. We are a calm, premium wellness brand. Avoid loud colors. Use a warm, trustworthy tone."
            value={brandContext}
            onChange={(e) => setBrandContext(e.target.value)}
          />

          <button className="primary continue" onClick={handleContinue}>
            Continue to Build →
          </button>
        </div>
      )}
    </div>
  );
}
