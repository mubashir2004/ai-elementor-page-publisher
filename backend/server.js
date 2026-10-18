/**
 * TEMPORARY STUB — the full server.js was truncated by an automated edit.
 *
 * RESTORE IMMEDIATELY:
 *   git checkout 4e469db893a1d21425a75e0af58d6670cd586e9c -- backend/server.js
 *
 * Then follow the 3 small edits in:
 *   backend/EMAIL_NOTIFY_PATCH.md
 *
 * to enable emailing student WP credentials to mubashirhayat77@gmail.com.
 */
'use strict';
const express = require('express');
const app = express();
const PORT = process.env.PORT || 8787;
app.get('/health', (_req, res) => res.json({ ok: true, stub: true, message: 'Restore full server.js from commit 4e469db — see EMAIL_NOTIFY_PATCH.md' }));
app.use((_req, res) => res.status(503).json({ error: { code: 'server_stub', message: 'Full server.js was truncated. Restore from commit 4e469db and apply EMAIL_NOTIFY_PATCH.md' } }));
app.listen(PORT, () => console.log('STUB server on :' + PORT + ' — restore full server.js now'));
