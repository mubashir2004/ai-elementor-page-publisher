# AI → Elementor Page Publisher

Turn a prompt, mockup images, or a scanned website into a fully-styled, professional Elementor page — published straight to a WordPress site. Bring-your-own-key: the user supplies their own Claude API key and a WordPress Application Password. **Everything runs locally — no cloud middleman.**

---

## What it does

- **Build from references** — upload up to 30 mockup images (PNG/JPG/PDF) or scan a live website; the pipeline extracts a design system and rebuilds the page in Elementor with section-by-section fidelity (desktop **and** mobile).
- **AI Chat** — describe a business in plain words and get a complete professional page (header, hero, services, testimonials, CTA, footer).
- **Design variations** — generate up to 3 style variations in parallel, compare them side by side, and transplant individual sections between variations with one click.
- **Widgets-first quality pipeline** — a validator + design-check layer enforces native Elementor widgets (free or free+Pro), correct flexbox container structure, one-header rules, mobile header rules (logo + hamburger + one CTA), readable typography floors, working mobile burger menus, and reference fidelity in both directions (nothing missing, nothing invented).
- **Always-on visual correction pass** — every generation is compared against the reference images and discrepancies are fixed before publishing; an optional Auto-refine pass adds a second, deeper polish.
- **Images** — automatic stock URL selection (sideloaded into the WordPress Media Library) or full AI image generation via Gemini (with a one-click key test on the Connect screen).
- **Elementor Pro support** — forms, nav menus, price tables, posts grids, loop grids with dynamic tags and taxonomy filters — used only when the connected site has Pro.
- **History & safety** — every publish is versioned; undo/redo, restore, and automatic backups. Refine any page (whole page or a single section) with plain-language instructions.
- **Brand kits & component library** — save brands (palette/context), reuse components across pages, and pull the site's Elementor Global widgets.

## Architecture

```
/frontend        React + Vite single-page app (Connect → Build / AI Chat)
/backend         Node/Express — sessions, SSE progress streaming, pipeline
  server.js        API endpoints (generate, refine, scan, history, brands…)
  generatePipeline.js  orchestrator: extract → generate → validate → correct → images → publish
  validator.js     deterministic validate + auto-repair engine
  claudeClient.js  Anthropic API client (BYOK, streaming, concurrency gate)
  geminiImageClient.js  Gemini image generation
  scanner.js       Playwright site scanner (full-page, viewport-stepped capture)
  wpClient.js      WordPress REST wrapper
/plugin          eai-connector — WordPress companion plugin (zip ready to install)
/prompts         system prompts: page generation, design extraction, design
                 recipes, pro construction patterns (the core IP)
```

All WordPress and Claude calls are server-side; the browser never holds credentials beyond the connect/generate POST. Page styling lives entirely inside the Elementor JSON via native settings — residual CSS is delivered per-page by the companion plugin, never via the Customizer.

## Getting started

Prerequisites: Node 20+, a WordPress site with Elementor (Pro optional), and Claude access — either a Claude API key **or** the [Claude Code CLI](https://claude.com/claude-code) installed and signed in (`npm install -g @anthropic-ai/claude-code`, then run `claude` once). Pick the mode on the Connect screen under **Claude access**.

```bash
# 1. Backend (terminal 1)
cd backend
npm install
npx playwright install chromium   # one-time — required for the website scanner
node server.js            # http://localhost:8787

# 2. Frontend (terminal 2)
cd frontend
npm install
npm run dev               # http://localhost:5173

# 3. WordPress plugin
#    Upload plugin/eai-connector.zip via Plugins → Add New → Upload, activate.

# 4. Connect
#    Open http://localhost:5173 — enter the site URL, a WordPress Application
#    Password (Users → Profile → Application Passwords), and your Claude API key.
#    Optionally add a Gemini key for AI-generated images (use the Test button).
```

## Tests

```bash
cd backend
node --test               # 100+ unit / integration tests (validator, pipeline,
                          # design checks, header rules, loop grids, history)
```

## Notes

- **No .env needed** — every setting has a working default (backend port 8787, frontend origin localhost:5173). `backend/.env.example` documents the variables; set them in your shell before `node server.js` if you want to override.
- The website scanner uses Playwright with software WebGL so maps/canvas render in screenshots. The Chromium binary is installed once via `npx playwright install chromium` (on Linux use `npx playwright install --with-deps chromium`); without it, only the scan feature is unavailable — everything else works.
- Open the app at `http://localhost:5173` (use `localhost`, not `127.0.0.1`).
- Generation quality is enforced in code, not just prompts: every confirmed failure class becomes a deterministic validator/pipeline rule with a regression test.
