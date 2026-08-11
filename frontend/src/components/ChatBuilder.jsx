/**
 * ============================================================
 * FILE: frontend/src/components/ChatBuilder.jsx
 *
 * Conversational page builder. Your first message GENERATES a
 * new draft Elementor page — or starts REFINING an existing
 * page if you pick one as the target. Each next message keeps
 * refining the last result. It reuses the same server pipeline
 * as the Build form, so the validator guarantees a NATIVE
 * ELEMENTOR page (never the HTML widget).
 *
 * All styling is self-contained in ChatBuilder.css (chatb-*
 * classes) — this screen does not depend on styles.css classes.
 * ============================================================
 */

import { useState, useRef, useEffect } from 'react';
import { streamRun, previewPage, listPages } from '../api';
import './ChatBuilder.css';

const STAGE_LABEL = {
  analyzing: 'Analyzing…',
  generating: 'Generating the page…',
  validating: 'Validating structure…',
  refining: 'Refining…',
  images: 'Fetching images…',
  publishing: 'Publishing draft…',
};

/** Remove HTML tags and collapse whitespace. */
function stripHtml(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Depth-first search for the first heading widget's text inside an element tree. */
function firstHeadingText(el) {
  if (!el || typeof el !== 'object') return '';
  if (el.widgetType === 'heading' && el.settings && el.settings.title) {
    const t = stripHtml(el.settings.title);
    if (t) return t;
  }
  const kids = Array.isArray(el.elements) ? el.elements : [];
  for (const kid of kids) {
    const t = firstHeadingText(kid);
    if (t) return t;
  }
  return '';
}

/** Chip label for a top-level element: first heading text, truncated to 24 chars. */
function sectionChipLabel(el, index) {
  let label = firstHeadingText(el) || `Section ${index + 1}`;
  if (label.length > 24) label = `${label.slice(0, 24).trimEnd()}…`;
  return label;
}

/** Tolerant page-title reader (plain string or WP-style { rendered }). */
function pageTitleOf(p) {
  if (!p) return 'Untitled';
  if (typeof p.title === 'string' && p.title) return p.title;
  if (p.title && typeof p.title.rendered === 'string') {
    return stripHtml(p.title.rendered) || 'Untitled';
  }
  return p.name || 'Untitled';
}

export default function ChatBuilder({ allowPro = false, brandContext = '' }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text:
        'Hi! Tell me the page you want and I’ll build it as a native Elementor page. ' +
        'Then just keep chatting to refine it — "make the hero darker", "add a pricing section", etc.',
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [result, setResult] = useState(null); // { pageId, rawJson, pageUrl, editorUrl, title }
  const [previewHtml, setPreviewHtml] = useState('');

  // Target selector: what the FIRST message acts on.
  const [target, setTarget] = useState('new'); // 'new' | 'existing'
  const [pages, setPages] = useState(null); // null = not loaded yet
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pagesError, setPagesError] = useState('');
  const [existingPageId, setExistingPageId] = useState('');

  const logRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, busy, stage]);

  const targetLocked = !!(result && result.pageId); // after first build we keep refining the last result
  const needsPageChoice = !targetLocked && target === 'existing' && !existingPageId;
  const canSend = !busy && !!input.trim() && !needsPageChoice;

  const selectedPage =
    (pages || []).find((p) => String(p.id) === String(existingPageId)) || null;

  const chips =
    result && result.rawJson && Array.isArray(result.rawJson.content)
      ? result.rawJson.content.map((el, i) => sectionChipLabel(el, i))
      : [];

  function push(role, text) {
    setMessages((m) => [...m, { role, text }]);
  }

  async function loadPages(force = false) {
    if (pagesLoading) return;
    if (pages !== null && !force) return;
    setPagesLoading(true);
    setPagesError('');
    try {
      const data = await listPages();
      const arr = Array.isArray(data)
        ? data
        : Array.isArray(data && data.pages)
          ? data.pages
          : Array.isArray(data && data.items)
            ? data.items
            : [];
      setPages(arr);
    } catch (e) {
      setPagesError((e && e.message) || 'Could not load pages.');
    } finally {
      setPagesLoading(false);
    }
  }

  function chooseTarget(t) {
    setTarget(t);
    if (t === 'existing') loadPages();
  }

  function scopeToSection(label) {
    if (busy) return;
    setInput((v) => `In the section "${label}": ${v}`);
    if (inputRef.current) inputRef.current.focus();
  }

  async function refreshPreview(json) {
    if (!json) return;
    try {
      const { html } = await previewPage(json);
      setPreviewHtml(html || '');
    } catch (_) {
      /* preview is best-effort */
    }
  }

  async function send() {
    const msg = input.trim();
    if (!msg || busy) return;
    const isFirst = !result || !result.pageId;
    if (isFirst && target === 'existing' && !existingPageId) return;

    push('user', msg);
    setInput('');
    setBusy(true);
    setStage(null);

    // NOTE: no imageMode here — sending one would overwrite the user's
    // session-stored choice (gemini/unsplash) with a hardcoded value; the
    // backend falls back to the session when the field is absent.
    const base = { allowPro, brandContext, template: 'canvas', includeHeader: 'full' };
    let path;
    let body;
    let fallbackPageId = null;
    let fallbackTitle = null;

    if (!isFirst) {
      // Keep refining whatever the last result was. The backend re-fetches
      // the page by id — sending the full JSON would just be dead payload.
      path = '/api/refine';
      body = { ...base, prompt: msg, pageId: result.pageId };
      fallbackPageId = result.pageId;
      fallbackTitle = result.title;
    } else if (target === 'existing') {
      // First message on an existing page: the backend fetches the page
      // itself — do NOT send currentJson.
      path = '/api/refine';
      fallbackPageId = Number(existingPageId) || existingPageId;
      fallbackTitle = selectedPage ? pageTitleOf(selectedPage) : null;
      body = { pageId: fallbackPageId, refinePrompt: msg };
    } else {
      // First message, new page.
      path = '/api/generate';
      body = { ...base, mode: 'new', prompt: msg, images: [], status: 'draft' };
    }

    await streamRun(path, body, {
      onProgress: (s) => setStage(s),
      onDone: async (data) => {
        const json = data.rawJson;
        const next = {
          pageId: data.pageId || fallbackPageId,
          rawJson: json,
          pageUrl: data.pageUrl,
          editorUrl: data.editorUrl,
          title: (json && json.title) || fallbackTitle || 'Your page',
        };
        setResult(next);
        const sections = json && Array.isArray(json.content) ? json.content.length : 0;
        push(
          'assistant',
          isFirst && target === 'new'
            ? `Built "${next.title}" — ${sections} section${sections === 1 ? '' : 's'}. Preview is on the right. Ask me to change anything.`
            : `Updated "${next.title}". Preview refreshed — anything else?`,
        );
        setBusy(false);
        setStage(null);
        refreshPreview(json);
      },
      onError: (e) => {
        push('assistant', `⚠️ ${e.message || 'Something went wrong.'}`);
        setBusy(false);
        setStage(null);
      },
    });
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const placeholder = targetLocked
    ? 'Describe a change…'
    : target === 'existing'
      ? existingPageId
        ? 'Describe the change to the selected page…'
        : 'Pick a page above, then describe the change…'
      : 'Describe the page you want…';

  return (
    <section className="chatb">
      {/* ---------- Chat pane (left) ---------- */}
      <div className="chatb-chat">
        <div className="chatb-note">
          <span className="chatb-note-badge">Native</span>
          Builds native <strong>Elementor pages</strong> (never HTML) from your instructions.
        </div>

        <div className="chatb-log" ref={logRef}>
          {messages.map((m, i) => (
            <div key={i} className={`chatb-msg chatb-msg--${m.role}`}>
              <div className="chatb-bubble">{m.text}</div>
            </div>
          ))}
        </div>

        <div className="chatb-foot">
          {/* Target selector */}
          <div className="chatb-target">
            <span className="chatb-target-label">Target:</span>
            {targetLocked ? (
              <span className="chatb-target-active">
                Refining “{result.title}”{result.pageId ? ` (#${result.pageId})` : ''}
              </span>
            ) : (
              <>
                <div className="chatb-seg" role="group" aria-label="Build target">
                  <button
                    type="button"
                    className={target === 'new' ? 'chatb-seg-btn is-active' : 'chatb-seg-btn'}
                    onClick={() => chooseTarget('new')}
                    disabled={busy}
                  >
                    New page
                  </button>
                  <button
                    type="button"
                    className={target === 'existing' ? 'chatb-seg-btn is-active' : 'chatb-seg-btn'}
                    onClick={() => chooseTarget('existing')}
                    disabled={busy}
                  >
                    Existing page ▾
                  </button>
                </div>
                {target === 'new' && (
                  <span className="chatb-target-hint">First message creates a new draft page.</span>
                )}
                {target === 'existing' &&
                  (pagesLoading ? (
                    <span className="chatb-target-hint">Loading pages…</span>
                  ) : pagesError ? (
                    <span className="chatb-target-hint chatb-target-hint--err">
                      {pagesError}{' '}
                      <button type="button" className="chatb-linkbtn" onClick={() => loadPages(true)}>
                        Retry
                      </button>
                    </span>
                  ) : pages && pages.length === 0 ? (
                    <span className="chatb-target-hint">No pages found on this site.</span>
                  ) : (
                    <select
                      className="chatb-select"
                      value={existingPageId}
                      onChange={(e) => setExistingPageId(e.target.value)}
                      disabled={busy}
                      aria-label="Existing page to refine"
                    >
                      <option value="">Choose a page…</option>
                      {(pages || []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {pageTitleOf(p)} (#{p.id})
                        </option>
                      ))}
                    </select>
                  ))}
              </>
            )}
          </div>

          {/* Section chips (scope the next change) */}
          {chips.length > 0 && (
            <div className="chatb-chips">
              <span className="chatb-chips-label">Sections:</span>
              {chips.map((label, i) => (
                <button
                  key={i}
                  type="button"
                  className="chatb-chip"
                  title={`Scope your next change to “${label}”`}
                  onClick={() => scopeToSection(label)}
                  disabled={busy}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Stage progress while a run streams */}
          {busy && (
            <div className="chatb-status" role="status">
              <span className="chatb-status-dot" />
              {STAGE_LABEL[stage] || 'Working…'}
            </div>
          )}

          {/* Input bar */}
          <div className="chatb-inputrow">
            <textarea
              ref={inputRef}
              className="chatb-input"
              rows={2}
              placeholder={placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <button
              type="button"
              className="chatb-send"
              onClick={send}
              disabled={!canSend}
              title={needsPageChoice ? 'Choose an existing page first' : undefined}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ---------- Live preview pane (right) ---------- */}
      <div className="chatb-preview">
        {result ? (
          <>
            <div className="chatb-preview-head">
              <span className="chatb-preview-title">{result.title}</span>
              <span className="chatb-preview-links">
                {result.pageUrl && (
                  <a href={result.pageUrl} target="_blank" rel="noreferrer">View</a>
                )}
                {result.editorUrl && (
                  <a href={result.editorUrl} target="_blank" rel="noreferrer">Edit in Elementor</a>
                )}
              </span>
            </div>
            {previewHtml ? (
              <iframe
                className="chatb-preview-frame"
                title="Page preview"
                srcDoc={previewHtml}
                sandbox=""
              />
            ) : (
              <div className="chatb-preview-empty">
                <p>Rendering preview…</p>
              </div>
            )}
          </>
        ) : (
          <div className="chatb-preview-empty">
            <p>Your page preview will appear here once you send your first message.</p>
          </div>
        )}
      </div>
    </section>
  );
}
