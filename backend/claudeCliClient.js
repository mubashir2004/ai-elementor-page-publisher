/**
 * ============================================================
 * FILE: backend/claudeCliClient.js
 *
 * Local Claude Code CLI transport — an alternative to the HTTP API.
 * When the user picks "Local Claude CLI" on the Connect screen, every
 * model call is executed through the locally installed `claude` binary
 * (print mode), using the user's own Claude Code login — no API key.
 *
 *   isAvailable()                 -> { ok, version | error }
 *   runMessage({system, messages, model, onDelta}) -> string (final text)
 *
 * Notes:
 * - The full prompt (system + conversation) is piped via STDIN — Windows
 *   caps argv at ~32KB and our system prompts are far larger.
 * - Reference images are written to a temp folder and the CLI is allowed
 *   ONLY the Read tool so the model can view them; nothing else runs.
 * - Output is the plain final response text (--output-format text), which
 *   the existing validator/JSON-repair layer already handles.
 * ============================================================
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_TIMEOUT_MS = 20 * 60 * 1000; // a full page can stream for a while

/** Run `claude` with args; prompt piped via stdin. Windows needs shell:true
 *  to resolve claude.cmd. Returns { code, stdout, stderr }. */
function execClaude(args, stdinText, cwd, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: cwd || os.tmpdir(),
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      reject(new Error('Claude CLI timed out after 20 minutes.'));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (onStdout) { try { onStdout(stdout.length); } catch (_) { /* progress must never break the run */ } }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the Claude CLI (${err.message}). Is Claude Code installed? (npm install -g @anthropic-ai/claude-code)`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (stdinText) child.stdin.write(stdinText, 'utf8');
    child.stdin.end();
  });
}

/** Quick availability probe for the Connect checklist. */
async function isAvailable() {
  try {
    const { code, stdout, stderr } = await execClaude(['--version'], '', null, null);
    if (code === 0 && stdout.trim()) return { ok: true, version: stdout.trim().split('\n')[0] };
    return { ok: false, error: (stderr || stdout || 'claude --version failed').slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Serialize an API-shaped message list into one plain-text transcript,
 *  extracting any image blocks to files in tmpDir. Returns { text, imagePaths }. */
function flattenMessages(messages, tmpDir) {
  const parts = [];
  const imagePaths = [];
  for (const m of messages || []) {
    const role = (m.role || 'user').toUpperCase();
    if (typeof m.content === 'string') {
      parts.push(`${role}:\n${m.content}`);
      continue;
    }
    const textBits = [];
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (!block) continue;
      if (block.type === 'text') textBits.push(block.text || '');
      else if (block.type === 'image' && block.source && block.source.data) {
        const ext = ((block.source.media_type || 'image/jpeg').split('/')[1] || 'jpg').split(';')[0];
        const file = path.join(tmpDir, `ref-${imagePaths.length + 1}.${ext}`);
        fs.writeFileSync(file, Buffer.from(block.source.data, 'base64'));
        imagePaths.push(file);
        textBits.push(`[reference image ${imagePaths.length}: ${file}]`);
      }
    }
    parts.push(`${role}:\n${textBits.join('\n')}`);
  }
  return { text: parts.join('\n\n'), imagePaths };
}

/**
 * One full model call through the local CLI. Mirrors the API client's
 * rawMessage contract: returns the final response text.
 */
async function runMessage({ system, messages, model, onDelta }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eai-cli-'));
  try {
    const { text: convo, imagePaths } = flattenMessages(messages, tmpDir);

    let prompt = '';
    if (system) prompt += `SYSTEM INSTRUCTIONS (follow these exactly):\n${system}\n\n=====\n\n`;
    prompt += convo;
    if (imagePaths.length) {
      prompt +=
        `\n\nIMPORTANT: the reference design images are saved as files. ` +
        `View EVERY one of these image files with the Read tool BEFORE answering:\n` +
        imagePaths.map((p) => `- ${p}`).join('\n');
    }
    prompt +=
      '\n\nRespond with ONLY the final answer content (raw output, no preamble, ' +
      'no commentary about reading files).';

    const args = ['-p', '--output-format', 'text'];
    // shell:true (needed on Windows for claude.cmd) concatenates args — only
    // a strictly alphanumeric model id may pass through.
    if (model && /^[a-z0-9._-]+$/i.test(String(model))) args.push('--model', String(model));
    if (imagePaths.length) args.push('--allowedTools', 'Read');

    const { code, stdout, stderr } = await execClaude(args, prompt, tmpDir, onDelta);
    if (code !== 0) {
      const detail = (stderr || stdout || '').slice(0, 300);
      if (/log ?in|authenticat|credential|api key/i.test(detail)) {
        throw new Error(`Claude CLI is not logged in — run \`claude\` once in a terminal and sign in. (${detail})`);
      }
      throw new Error(`Claude CLI exited with code ${code}: ${detail}`);
    }
    const out = stdout.trim();
    if (!out) throw new Error(`Claude CLI returned no output. ${(stderr || '').slice(0, 200)}`);
    return out;
  } finally {
    // Best-effort temp cleanup — never let it break a successful run.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

module.exports = { isAvailable, runMessage };
