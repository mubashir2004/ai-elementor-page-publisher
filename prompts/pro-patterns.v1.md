<!--
============================================================
FILE: prompts/pro-patterns.v1.md  (content: PRO FOUNDATIONS v2)
PURPOSE: The definitive construction bible MINED EXHAUSTIVELY
         from the owner's three professional Elementor template
         kits (ref templates/: breno, debrisco, trashcure —
         ALL 55 page JSONs + manifests + global kits analyzed
         by 5 specialist passes: heroes/sections, headers/
         footers/globals, component styling, special pages,
         responsive engineering).
         Appended to the page-gen AND refine system prompts.
============================================================
-->

# PRO FOUNDATIONS v2 — Elementor Construction Bible
Distilled from 55 template JSONs across 3 professional kits (breno / debrisco / trashcure). All patterns verified by frequency; rare variants marked (optional).

## 1. CORE CONSTRUCTION LAWS
1. **Containers only.** Every element is `elType:"container"` or `elType:"widget"`. Zero sections/columns. `elementor_pro_required:false` where possible.
2. **Page = flat array of top-level "bands"** (8–18 on home, 3–9 on subpages). Bands own background + vertical padding; never `html_tag` (always default div) — EXCEPTION: when this system generates an IN-PAGE header, that one band carries `html_tag:"header"` (required by the header rules; the kits ship separate header templates instead).
3. **Bands are boxed by default**: omit `content_width` entirely (kit `container_width:1280px`). Set `content_width:"full"` ONLY for maps, embedded form partials, edge-to-edge strips (12/167 bands).
4. **Columns = child containers** with `content_width:"full"` + `width:{"unit":"%","size":N}`. Never widgets directly under a band unless the band is a single centered column.
5. **Item-in-own-container**: card chrome (padding/radius/border/bg/shadow/animation) lives on a container; widgets inside only style content. Repeating items = one container per item.
6. **Vertical rhythm** = band `padding` with left/right 0: `{"unit":"px","top":100,"bottom":100}` (px kits) or `{"unit":"em","top":7,"bottom":7}`. Split idiom (optional): header band `100/50` + content band `0/100`.
7. **Nesting depth 2–4** from band root: band → % columns → widgets (→ card containers → widgets). Never deeper.
8. **Grids are flex**: parent `flex_direction:"row"` + `flex_wrap:"wrap"` + children `width:32%`(3-up)/`48%`(2-up)/`25%`(4-up). `container_type:"grid"` with `grid_columns_grid:{"unit":"fr","size":3–4}` is optional (1 kit only).
9. **Image-as-container**: photo halves/decor = container with `background_background:"classic"` + image cover/center + `min_height` (+ lone `spacer` child if empty) + `border_radius`. Photos inside cards = `image` widget with `height`+`object-fit:"cover"`.
10. **(Only when told to use the site's Elementor globals)** every color/typography routes through `settings.__globals__` (`"globals/colors?id=X"` / `"globals/typography?id=X"`). Empty string `""` unlinks → kit default applies. Literal hex only for `#FFFFFF` on dark and one-off overlays. **IN REFERENCE-DRIVEN BUILDS (the normal case here): use the reference's LITERAL hex values instead — never emit `__globals__` refs to slugs that may not exist on the target site.** The globals discipline describes HOW pros keep one design system; you achieve the same by reusing ONE palette of literal hexes consistently.
11. **Cross-band overlap** = negative `margin` top on the following band (`-100` to `-505px`) + `z_index:1` where needed.
12. Page settings: `{"hide_title":"yes","template":"elementor_header_footer"}` (canvas for standalone header/footer).

## 2. CANONICAL BAND SKELETONS
**H1 — Split hero (dark)**: band(row, gap 0, pad `8em 0 15em 0` or `100px`, bg=G(dark) + `background_overlay_image` texture, cover, opacity 1)
├─ col 50% (T:60%), anim fadeInLeft delay 300: eyebrow(heading `header_size:"div"`, accent color) → h1(white, G typo) → text-editor → row(gap 30): [primary button (all `__globals__:""` = kit default, icon `fas fa-arrow-circle-right`, `icon_indent:10`, `hover_animation:"shrink"`)] + [white button]
└─ col 42.5%, `position:"absolute"`, `_offset_orientation_h:"end"`, `min_height:{"unit":"custom","size":"100%"}`, bg slideshow/image, `border_radius:{200,0,0,15}` (optional badge container 100px sq, radius `{0,15,0,15}`).

**H2 — Full-bleed centered hero**: band(column, `min_height:{"unit":"vh","size":100}` (T/M 90), pad `170px 0 50 0`, align/justify center, bg image cover + `background_overlay_color:"#000000"` `background_overlay_opacity:0.65`)
└─ col 55%, gap 16, centered, anim fadeInUp: eyebrow(heading default-h2, 14px G typo, white) → h1 72px `letter_spacing:-1.3` `line_height:1.1em` → text → button pair row(gap 16). Optional social-proof row 30% (avatars + text).

**H3 — Overlap hero**: band(row, `margin:{"top":-100}`, `z_index:1`, pad `200px 0 100 0`, bg image + `background_overlay_background:"gradient"` dark→transparent `center left`, opacity 0.7) → col 80%, anim zoomIn: h1 → text → stats row → button/form row.

**Inner-page banner**: dark band pad `7em 0`; col 50% [h1 + text-editor breadcrumb "Home / Page"] + col 50% absolute bg-image `border_radius:{150,0,0,15}` `hide_mobile` (spacer child). Alt: centered band `min_height:500px` (T400/M300), img + #000 overlay 0.6, col 55% [h1 + breadcrumb].

**S1 — Centered header + card grid**: band(column, align center, gap 48, pad 100 0, bg alternation token) → header col 50% gap 16 [eyebrow + h2 56px] → grid/wrap row → N cards (`padding:24` linked, `border_radius:8`, bg = OPPOSITE token of band, anim fadeInUp).

**S2 — Split header + content**: band(column, gap 48–50, pad 100/7em 0) → row1: left col [eyebrow + h2] fadeInLeft + right col [text-editor, `justify:flex-end`] fadeInRight → row2: card row gap 20–50, cards 32%×3 or 25%×4 + `flex_wrap`.

**S3 — Two-column media/text** (most common band): band(row, gap 30–50, pad 100px/7em 0) → media col 45–51.5% (image `height:430`+cover+radius, or bg-image container) + text col 40–60% [eyebrow → h2 → text → icon-list/counters → button]. Splits: 50/50 dominant; 45/55, 40/60, 65/35 optional. Optional divider widget under eyebrow.

**S4 — Full-bleed CTA**: band(bg image cover + dark overlay #000 op 0.6 or brand gradient, `min_height:600px` or pad 7em 0) → single centered col 45–65%, gap 16, fadeInUp: eyebrow + h1/h2 + text + button pair (or inline form).

**Stats row**: row of 25–33% cols, each [counter (`ending_number`, `suffix:"+"`, `title:""`, `number_position:"start"`, number color=G accent, typo="Number Text" 4rem) + heading label below].

**Testimonial band**: band (tint or dark bg, optional texture overlay op 0.1) → S2 header → testimonial/loop-carousel widget, `slides_to_show 3→T1`. Manual card (optional): container pad 30, radius, bg → text-editor quote + rating (`rating_value:4.5`, `icon_gap:3`, star color G accent) + row [image circle-radius + heading h5 + heading div role].

**S5 — Overlap caption card** (optional signature): absolute-positioned card container width 90%/280–400px, pad 30, bg=G(dark/accent), asymmetric `border_radius:{15,0,15,0}`, over a sibling image; or negative top margin on next band.

## 3. SPECIAL PAGE SKELETONS
**PRICING**: hero → (optional intro col 65%) → card row (3 equal, or grid 3-col T2) → CTA or FAQ split band → testimonials. Card tree: container(pad 40 linked M20, gap 20, `border_border:"solid"` 1px G divider, radius 15, fadeInLeft delay 300/600) → row space-between [plan-name heading + icon] → price row(gap 0) [heading "$" h4 + heading "99" h1 (G accent, `_element_width:"initial"` custom 110px) + heading "Per Month" h6] → text-editor → button `align:"justify"` full-width → divider → icon-list 4× `fas fa-check-circle`, `space_between:15`, `icon_size:20`. **Featured** = same + `background_color`→G tint + border transparent. Price is ALWAYS separate headings in a flex row, never one heading.

**TEAM**: hero → centered header + 6-card wrap grid (32%→T48%). Card A (bg-image): container 32%, pad 30, radius 15, `flex_gap:250px` (=height spacer, T150), bg photo + gradient overlay (transparent→dark, op 0.9) → social-icons + name box(`border_width:{left:5}` G accent bar, pad-left 20, `_flex_align_self:"flex-end"`) [heading h4 + heading div role]. Card B (flat): pad 24, radius 8, bg gray → image(radius 8) → row space-between [col 70% (name heading + role text) + social-icons].

**FAQ**: hero → split band(row, gap 48, pad 100 0): left 45–50% [eyebrow + h2 category + text (+button/image)] + right 50–55% `nested-accordion`. Accordion NEVER full-width alone. Multi-category: repeat split band per category, or (optional, richest) `nested-tabs` `tabs_direction:"inline-start"`, `tabs_width:30%`, tab bg transparent all states, each tab → nested-accordion of 4 items.

**CONTACT**: hero → info+form band(row, space-between, gap 48–50): left 30–50% [eyebrow + h2 + text + contact items: rows of (icon widget stacked/rounded + col [heading h6 label + heading h4 value]) or 2×2 grid of cards(row, ai center, gap 16, bg gray, radius 8)] + right 50–66% form card(pad 24, bg, radius 8, fadeInRight) wrapping Pro `form` → map band: `google_maps` `height:500` (T400/M300), `_border_radius:8`; grayscale optional: `css_filters_css_filter:"custom"` + `css_filters_saturate:{"size":0}` → FAQ block reused. Map-overlap variant (optional): full-width map 600px → next band `margin:{"top":-505}` with white info card + form card.
**Form fields**: every field `_element_width:"initial"` + `_element_custom_width:48%` (textarea/submit 100%); input pad 20, bottom-border-only `input_border_normal_width:{0,0,1,0}`, radius 0, placeholder-as-label.

**PORTFOLIO**: hero → centered header + wrap row(gap {20,25}) of 4 cards: container 49%, `justify:flex-end`, `min_height:500px`, bg image cover, radius 15 → caption panel(width 500px, pad 30, bg classic, radius `{0,15,0,15}`) [icon-list 1-item category + heading h4 + text + "Learn More" button]. Alt (optional): vertical list of horizontal cards(row, gap 48, pad 24, bg gray, radius 8) [image 50% h350 cover + col 50% [heading+text → divider → two 2-item icon-lists meta → button]].

**404**: single band. Giant "404" as its OWN heading (div/h1, display typo 110–170px, accent or white) → "Page Not Found" heading → text-editor → button "Back to Home" (+ optional second button / icon-list help links / social-icons). Bg = photo + #000 overlay 0.6 `min_height:90vh` centered, or plain color pad 7em.

**BLOG LIST**: hero → centered header → single Pro `posts`/`loop-grid` widget. No custom cards.
**SINGLE POST** (optional): hero → row: sidebar 30% [recent-posts card + CTA card] + content 66% [image → meta icon-list row → divider → headings/text → quote card(pad 30, bg, radius 15)]. Or centered article `boxed_width:900px`, gap 34.

## 4. HEADER & FOOTER CONSTRUCTION
**Header** = standalone `header.json` (`type:"section"`, `template_type:"section-header"`); pages NEVER embed nav. Formula:
- Optional topbar: row, pad 10–20 0, bg=G(brand/dark) → icon-list contacts (small typo) + social/legal; desktop/mobile swap via `hide_tablet`+`hide_mobile` on one widget and `hide_desktop` on its counterpart. Contact links as transparent buttons (bg→G transparent slug) optional.
- Main bar: row, `flex_gap:0`, align center, pad 16–20 0, bg white; T: `flex_wrap_tablet:"wrap"`. Three `content_width:"full"` columns: **logo 20–30%** (image widget, width 75%, T:30%, M:60%, link to home) / **menu 45–60%** (Pro `nav-menu`; hamburger comes from widget, styled via `__globals__`: text→text, hover/active→brand, typo→"Navigation" 14px 500 uppercase) / **CTA 20–30%** (button, align right, `hide_tablet`+`hide_mobile:"yes"`).
- No sticky settings. Transparent-header variant (optional): header `margin-top:20`, `z_index:5`; hero pulls up with `margin:{"top":-100}`.

**Footer** = `footer.json` (`section-footer`). Single container, column, bg=G(dark/brand), pad `70–100px 0` or 7em:
- Optional CTA row: heading 55% + button pair 45% `justify:flex-end`, `border_width:{0,0,1,0}` solid, G border color, pad-bottom 50.
- Link row(row, gap 50 / space-between): **brand col 30–40%** [image light logo w50% + text-editor blurb (muted G color) + social-icons or newsletter form] + **2–3 link cols 11–27%** [heading (h4 typo G, white/off-white) + icon-list 5–6 links, NO icons (`{"value":"","library":""}`), text→G accent/muted, `text_color_hover`→white] (+ optional contact col: icon+heading fixed-px pairs). Tablet widths 44–50% (2-up), mobile reset.
- Separator: `divider` widget or `border_width:{1,0,0,0}` with `__globals__.border_color`→G border grey.
- Bottom bar: row `justify:space-between`, align center: copyright text-editor left + right container `justify:flex-end` of legal links as transparent-bg buttons (bg→G transparent, Button typo).

## 5. COMPONENT DEFAULTS CHEAT SHEET
- **button**: `text`; icon `{"value":"fas fa-arrow-circle-right","library":"fa-solid"}` + `icon_align:"row-reverse"` + `icon_indent:{"unit":"px","size":10}`; `hover_animation:"shrink"`. Primary = NO colors set (kit defaults: pad `16–20/28–45`, radius 8–15, via global.json). Inverted = `background_color:"#FFFFFF"` + `button_text_color`→dark. Text-link = `text_padding` all 0 + `border_radius` all 0 + bg→G transparent (`#xxxxxx00`) + `hover_color`→G accent. Full-width = `align:"justify"`. Hover colors always in pairs (`hover_color` + `button_background_hover_color`).
- **heading**: color via `__globals__.title_color`; size via `__globals__.typography_typography`→kit H1–H6 tokens (tag = semantic-optional; default-h2 + token is safe). Eyebrow = `header_size:"div"` (or default) + accent G color + small G typo. Width cap: `_element_width:"initial"` + `_element_custom_width:{"unit":"%","size":60}`. Pill label (optional): `_padding:{10,15,10,15}` + `_border_radius:100` + `_background_background:"classic"`.
- **text-editor**: `__globals__.text_color`→text token; `paragraph_spacing:{"unit":"px","size":0}` (gaps at container); width via `_element_custom_width` 68–100%; spacing via `_padding` top 20.
- **icon-list**: `icon_color`→G brand + `text_color`→G text; hover = `text_color_hover`→G brand only; `icon_size:20` (M15); `space_between:10–15`; `text_indent:0–5`; check items `fas fa-check-circle`; footer links icon empty.
- **image**: `image_border_radius` 8/10/15 linked (kit token); crop = `height:{"unit":"px","size":350–440}` + `object-fit:"cover"`; circle portrait = radius 100–999 + optional 3–5px solid `image_border_*` in G accent.
- **divider**: `__globals__.color`→G divider grey (full-width, `gap:0–10`) or accent underline: `width:{"unit":"%","size":20}` + `align:"left"` + `weight:{"size":2}`, `align_mobile:"center"`.
- **icon**: `view:"stacked"` + `shape:"rounded"` + `icon_padding:15` + `size:25–30` (M20); `__globals__.primary_color`→brand, `secondary_color`→white; optional tuck: `_margin:{"top":-25}`.
- **image-box**: `image_size:{"unit":"%","size":18–22}`, `image_space:28`, `text_align:"start"`, `title_bottom_space:5–10`, title typo→h4 token.
- **social-icons**: fa-brands (facebook-f, x-twitter, linkedin-in, instagram, youtube); `icon_color:"custom"` ALWAYS + all four via `__globals__`: `icon_primary_color`(chip, often transparent), `icon_secondary_color`, `hover_primary_color`(darker brand), `hover_secondary_color`; `icon_size:18–20`; footer stack: `columns:"1"` + `row_gap:5–10`.
- **counter**: `ending_number` + `suffix:"+"`, `title:""` (label = separate heading), `number_position:"start"`, `number_color`→G accent, number typo→"Number Text".
- **nested-accordion**: `accordion_item_title_position_horizontal:"stretch"`, `accordion_item_title_icon_position:"end"`, `accordion_item_title_space_between:25`, `accordion_padding:{0,0,15,0}`, `accordion_border_normal_border:"none"`, `content_border_border:"none"`, title typo→h4 token, `_animation:"fadeInRight"`, 4 items, answers = child container → text-editor.
- **google_maps**: `address` string, `height:500–600`, `_border_radius:8`; grayscale = `css_filters_css_filter:"custom"` + `css_filters_saturate:0`.
- **Card containers**: flat = pad 24 + radius 8 + G bg, no border/shadow. Bordered = pad 40 + radius 15 + 1px solid G divider. Hover-lift (optional): base shadow `0 0 60px 10px rgba(0,0,0,0.05)`; hover `box_shadow_hover_box_shadow:{0,25,40,0,"rgba(0,0,0,0.1)"}` + `_transform_translateY_effect_hover:{"size":1}` + `_transform_transition_hover:{"size":600}`. Asymmetric radius `{15,0,15,0}` optional signature.
- **Animations**: on columns/cards, NEVER on bands. Left col fadeInLeft, right fadeInRight, centered/cards fadeInUp, stagger `animation_delay` 300/600. Hovers = color swaps + shrink only; no scale/rotate.
- **Omit noise keys**: empty `_background_image`/`_mask_image` objects, `*_stop_tablet`, gradient position residue, `background_video_fallback`.

## 6. THE RESPONSIVE RULEBOOK
1. Three states only: desktop, `_tablet`, `_mobile` (`viewport_md:768`, `viewport_lg:1025`). No extra breakpoints ever.
2. **Stacking**: never set `flex_direction_mobile:"column"` (it's the default). Mobile width = explicit RESET `width_mobile:{"unit":"%","size":"","sizes":[]}` — never hardcode 100%. Tablet stack: parent `flex_direction_tablet:"column"` + text child `width_tablet:100%`.
3. **2-col split**: text `50→T100→M reset`; media `50→T65→M reset`. Optional rebalance-stay-row: `50→T61` / `50→T40`. Deliberate 2-up mobile: `25→T50→M47` + column gap 18–20.
4. **Card grids**: 3-col `32%→T48%→M reset`; 4-card `48%→T100→M reset` or `25%→T48→M reset` (+`flex_wrap_tablet:"wrap"`); grid container `4fr→T2→M default`.
5. **Band padding**: `100/0/100/0 → T 70/32/70/32 → M 70/20/70/20` (add side gutters when boxed width stops providing them). Em alternative: `7em 0` fixed + Site Settings `container_width_tablet/mobile:90%`.
6. **Card padding**: 30–40 linked → M20; tablet inherits.
7. **Typography scales live in global.json**, not on widgets: h1 72→60→40, h2 56→40→32, h3 40→28→24, h4 32→24→22, body 16 fixed or →14. Mobile ≈ 55–70% of desktop for large sizes. Widget-level exception: hero h1s/buttons `1rem→0.9→0.8`.
8. **Alignment**: pick one system — center-everything-mobile (`align_mobile:"center"` on headings/text/dividers/buttons) OR keep-left + full-width mobile buttons (`align_mobile:"justify"` + `_element_width_mobile:"inherit"`).
9. **Widget widths**: 2-up fields/lists `_element_custom_width:48%` → `_element_width_mobile:"inherit"`; constrained paragraphs `68–77%→T90→M100`.
10. **hide_***: only decorative/secondary chrome — spacer/decor columns `hide_mobile:"hidden-mobile"`, header CTA `hide_tablet`+`hide_mobile`, topbar swaps via `hide_desktop`. Never hide content bands.
11. **Gaps**: tablet ≈ 50–66% of desktop (`48→T32`, `50→T20`); mobile 10–20. Stacked-block separation: `margin_mobile:{"top":"15–30"}`.
12. **Media**: image `height 350→T400→M300` + cover, or fixed 430px all devices; maps `500→400→300`; icon sizes M ≈ 66–80%; carousels `slides_to_show 5→T3→M2`, testimonials `3→T1`.
13. **Reorder**: `_flex_order_mobile:"end"` on media/decoration; `_flex_order_tablet:"start"` on sidebar/form. `z_index_mobile:2` on banner text over decorative overlaps.

## 7. GLOBAL CONSISTENCY SYSTEM
1. Ship 3 core files: `header.json` (section-header), `footer.json` (section-footer), `global.json` (`{"version":"0.4","type":"section","metadata":{"template_type":"global-styles"},"content":[],"page_settings":{...}}` — everything in page_settings). Manifest: `manifest_version`, `templates[]` with `template_type` vocabulary (`global-styles|section-header|section-footer|single-page|single-404|archive-blog|...`).
2. **Colors**: 4 `system_colors` (slugs `primary,secondary,text,accent`) + `custom_colors` with random 7-hex `_id`s. Roster MUST include: white, transparent (8-digit hex ending `00` — powers ghost buttons), border/divider grey, dark footer/section bg, card-tint (#F6F6F6-class), brand + brand-darker (hover).
3. **Typography**: 4 `system_typography` + custom tokens named H1–H6 + Navigation(14px uppercase) + Button + Small Text + Number Text + display Heading Text. Every token sets `_font_size` + `_font_size_tablet` + `_font_size_mobile` (all 3, always), `_line_height` in em.
4. **Kit-level defaults in page_settings**: `container_width:1280`, `button_border_radius` (one value 8–15 kit-wide), `button_padding` at 3 breakpoints, form field border defaults, `page_title_selector:"h1.entry-title"`.
5. **Theme-style wiring** via `page_settings.__globals__`: `h1_color…h6_color`→color slugs, `h1_typography_typography…`→matching typo tokens, `body_color`→text, `button_*` normal+hover→brand pair, `link_normal_color`/`link_hover_color`→brand/darker.
6. **Widget discipline**: ~75% of widgets carry `__globals__`; global refs outnumber literal hex ~10:1. Every color/typo = `settings.__globals__.<control>:"globals/colors?id=<slug>"`. `""` = fall back to kit default (this IS how the primary button works).
7. **One radius, one card pad, one gap per kit**: pick radius 8, 10, or 15 and use everywhere (buttons, cards, images, maps); pick card pad (24/30/40) and band gap (48/50) and repeat.
8. **Background alternation tokens**: strict 2-token band alternation (tint ↔ transparent/white) with cards taking the OPPOSITE token of their band; dark bands from one dark slug, optionally always paired with the same texture `background_overlay_image` (op 1 hero, 0.1 elsewhere).
9. **Band recycling**: build CTA band, closer band, testimonial band, FAQ block ONCE and re-emit identical JSON on every page that needs them.
10. **Third-party → core swaps** (always): ekit/jkit nav → Pro `nav-menu`; metform/rform → Pro `form`; ekit/jkit accordion → `nested-accordion`; blog widgets → Pro `posts`/`loop-grid`; jkit_team/image_box → container+image+heading+text(+social-icons) or `image-box`; testimonial plugins → `testimonial-carousel`/loop-carousel; breadcrumb plugins → text-editor "Home / Page"; gum_*/ha-post-* → Pro theme-post-* widgets; site-logo → `image`.

## 8. ADDITIONAL OWNER RULES (kept from v1 mining)

- **Press / "featured in" strips**: brand names are NEVER a lump of bold text — muted uppercase eyebrow, then ONE justified row (`flex_justify_content:"space-between"`, wrap mobile) of evenly spaced grey letter-spaced brand-name headings (or grey logo images).
- **Header logo text stays on ONE line always** — brand name in a single heading; taglines are separate small text hidden on mobile; the logo heading carries `typography_font_size_mobile` (~18–20px).
- **Text never clips**: if a title is wider than its card, the card is too narrow — widen the column set or shrink the type; long uppercase words must wrap, never overflow the card edge.
- **Image subjects match the section topic** — an off-topic stock photo is worse than a solid color block.
