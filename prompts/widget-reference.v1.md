<!--
============================================================
FILE: prompts/widget-reference.v1.md
PURPOSE: The prototype's per-widget knowledge base — every
         whitelisted widget's Content tab, Style tab, and the
         universal Advanced tab, expressed as the EXACT JSON
         keys Elementor persists in _elementor_data.

SOURCE: Distilled from the project owner's full Elementor
        widget dictionary (elementor-wedget-explained.md) and
        key-verified against the EMCP widget catalogs +
        Elementor core. UI panels -> JSON keys.

Loaded at startup and appended to the page-gen system prompt.
The single PRO_ONLY block is stripped for free-tier sites.

CHANGELOG:
  v1 — initial: universal patterns + 24 free widgets + 15 Pro
       widgets, three-tab coverage.
============================================================
-->

# WIDGET KNOWLEDGE BASE — Content / Style / Advanced as JSON keys

Elementor's editor organizes every widget into three tabs. You are writing the JSON those tabs persist. For EVERY widget you place, think through all three tabs like a designer would in the editor:
1. **[Content]** — the words, images, links, repeater items.
2. **[Style]** — colors, typography, borders, shadows, sizing for each part of the widget.
3. **[Advanced]** — the universal wrapper: spacing, width, background, border, motion, position, z-index.

Never emit a bare content-only widget when the design calls for styling. Never invent keys — use the keys below (or the section/column keys in the main prompt). A wrong key is silently ignored and the styling is lost.

## UNIVERSAL VALUE SHAPES

- Slider/size: `{ "unit": "px", "size": 24, "sizes": [] }` (units px/%/em/rem/vw/vh).
- Dimensions (padding/margin/border-width/radius): `{ "unit": "px", "top": "16", "right": "16", "bottom": "16", "left": "16", "isLinked": true }`.
- Link: `{ "url": "#anchor", "is_external": "", "nofollow": "", "custom_attributes": "" }`.
- Image: `{ "url": "https://...", "id": "", "alt": "descriptive alt", "source": "library" }`.
- Icon: `{ "value": "fas fa-star", "library": "fa-solid" }` (brands: `"fab fa-instagram"`/`fa-brands`; regular: `far`/`fa-regular`). Never inline SVG markup.
- Responsive override: append `_tablet` / `_mobile` to most keys (`align_mobile`, `padding_mobile`, `typography_font_size_mobile`).

## UNIVERSAL TYPOGRAPHY ENGINE (any text part of any widget)

Enable with `"<group>_typography": "custom"` first, then the sub-keys:
`<group>_font_family` (Google Font name), `<group>_font_size` (slider), `<group>_font_weight` ("100".."900"|"normal"|"bold"), `<group>_text_transform` (""|"uppercase"|"lowercase"|"capitalize"|"none"), `<group>_font_style` (""|"normal"|"italic"|"oblique"), `<group>_text_decoration` (""|"none"|"underline"|"overline"|"line-through"), `<group>_line_height` (slider, em), `<group>_letter_spacing` (slider), `<group>_word_spacing` (slider).
Group names per widget are listed below (`typography`, `title_typography`, `description_typography`, `menu_typography`, …).

## UNIVERSAL ADVANCED TAB (every widget — keys prefixed `_`)

- Layout: `_margin`, `_padding` (dimensions), `_element_width:"initial"` + `_element_custom_width` (slider), `_z_index` (int), `_css_classes`, `_element_id`.
- Position (pinned/floating accents only): `_position:"absolute"` + `_offset_x`/`_offset_y` (sliders). Use sparingly — only when the reference shows an element pinned over another.
- Background: `_background_background:"classic"` + `_background_color` / `_background_image`; hover: `_background_hover_*`.
- Border: `_border_border` (""|"solid"|"double"|"dotted"|"dashed"|"groove"), `_border_width`, `_border_color`, `_border_radius`, `_box_shadow_box_shadow_type:"yes"` + `_box_shadow_box_shadow:{horizontal,vertical,blur,spread,color}`.
- Motion: `_animation` ("fadeIn","fadeInUp","fadeInDown","fadeInLeft","fadeInRight","zoomIn","slideInUp","bounceIn",…), `_animation_delay` (ms int). Stagger card rows (0/150/300/450).
- Sections/columns use the SAME groups WITHOUT the `_` prefix (`animation`, `z_index`, `border_radius`, `box_shadow_box_shadow`, …) — see the main prompt.

# THE CONTAINER (elType:"container") — YOUR PRIMARY LAYOUT ELEMENT

Build pages with flexbox CONTAINERS by default (not section/column). A container holds widgets AND nested containers directly — no columns needed. Nested containers carry `isInner:true`.

**[Layout tab]**
- `container_type:"flex"` (default; `"grid"` for strict grids), `content_width` ("boxed" caps content at site width | "full"), `width` ({unit:"%",size:50} — how a CHILD container sizes itself inside a row; **REQUIRES `content_width:"full"` on that same child, or the width is silently ignored and the child renders 100% wide**), `min_height` (slider — heroes ~{unit:"px",size:560}), `html_tag` ("div"|"section"|"header"|"footer"|"aside").
- Flex: `flex_direction` ("row"|"column"|"row-reverse"|"column-reverse"; responsive `flex_direction_mobile:"column"` to stack on phones), `flex_justify_content` ("flex-start"|"center"|"flex-end"|"space-between"|"space-around"|"space-evenly"), `flex_align_items` ("flex-start"|"center"|"flex-end"|"stretch"), `flex_wrap` ("nowrap"|"wrap"; responsive variant `flex_wrap_mobile:"wrap"` stacks a desktop row on phones — base `flex_wrap` is the DESKTOP layout, so single-row layouts leave it unset/nowrap and wrap only via `flex_wrap_mobile`), `flex_gap` ({"column":"24","row":"24","isLinked":true,"unit":"px"}).
- Grid (when `container_type:"grid"`): `grid_columns_grid` ({size:3}), `grid_rows_grid`, `grid_gaps`.

**[Style tab]** (same groups as section — your screenshots' Background / Background Overlay / Border / Shape Divider panels)
- Background: `background_background:"classic"` + `background_color` / `background_image` + `background_position` + `background_size`, or `"gradient"` + `background_color_b` + stops/angle.
- Background Overlay (the scrim/fade layer): `background_overlay_background:"classic"|"gradient"` + `background_overlay_color(_b/_stop/_b_stop)` + `background_overlay_gradient_type/_angle` + ALWAYS `background_overlay_opacity:{unit:"px",size:1,sizes:[]}`.
- Border: `border_border`/`border_width`/`border_color`, `border_radius`, `box_shadow_box_shadow_type:"yes"` + `box_shadow_box_shadow`.
- Shape Divider: `shape_divider_top`/`shape_divider_bottom` ("waves"|"tilt"|"curve"|"triangle"|"drops"|…) + `_color` + `_height`.

**[Advanced tab]** — `margin`, `padding`, `z_index`, `css_classes`, Motion Effects: `animation` ("fadeIn"|"fadeInUp"|"zoomIn"|…) + `animation_delay` + `animation_duration` ("slow"|""|"fast"); Transform (rotate/offset/scale — use sparingly, never on sticky).

**Container building patterns:**
- **Page** = a stack of top-level containers (one per band), each `content_width:"boxed"` (or `"full"` for edge-to-edge), `flex_direction:"column"`.
- **Row of cards** = a container with `flex_direction:"row"` + `flex_gap` + child containers each `content_width:"full"` + `width:{unit:"%",size:31}` (BOTH keys — width alone is ignored); the CARD is the child container itself (background + `border_radius` + `box_shadow` + `padding`) with its widgets stacked inside. Responsive: `flex_wrap_mobile:"wrap"` on the row + child `width_mobile:{unit:"%",size:100}` — the base row stays unwrapped (widths + gap sized to fit one desktop line, e.g. 31/31/31); only multi-row grids (5+ cards) carry base `flex_wrap:"wrap"`.
- **Two-column hero** = row container, two children (text container `content_width:"full"` + `width` ~55%, image container `content_width:"full"` + `width` ~45%), `flex_align_items:"center"`.
- **Content-on-image** = the parent container carries `background_image` + gradient `background_overlay` (the scrim) + `min_height` + **`flex_direction:"row"`** (containers default to column, where justify-content is VERTICAL — the row axis is required for side placement); a single child container (`content_width:"full"` + `width` ~50%) holds the content, pushed to the correct side with `flex_justify_content:"flex-end"` (right) or `"flex-start"` (left).
- **Floating/overlap** = negative `margin` top on the following container + `z_index`, exactly like the section pattern.
- Legacy section → column → widget remains AVAILABLE as a fallback when a layout genuinely fits it better — all styling keys are the same groups.

# FREE WIDGETS

**heading** — [Content] `title` (may contain `<span>`/`<em>`/`<br>`), `header_size` ("h1".."h6"|"div"|"span"|"p"), `link`. [Style] `align`(+resp), `title_color`, `typography_*`, `blend_mode` (""|"multiply"|"screen"|"overlay"|"darken"|"lighten"|…), `text_stroke_text_stroke:"yes"` + `text_stroke_stroke_width`/`text_stroke_stroke_color`, `title_text_shadow_text_shadow:{horizontal,vertical,blur,color}`.

**text-editor** — [Content] `editor` (HTML: `<p>`, `<ul>`, `<strong>`…). [Style] `align`(+resp), `text_color`, `typography_*`, `drop_cap:"yes"`, `text_columns` ("1".."10"), `column_gap` (slider).

**image** — [Content] `image`, `image_size` ("thumbnail"|"medium"|"medium_large"|"large"|"full"), `caption_source:"custom"` + `caption`, `link_to` ("none"|"file"|"custom") + `link`. [Style] `align`(+resp), `width`/`max_width`/`height` (sliders) + `object-fit` (""|"fill"|"cover"|"contain"), `opacity` (0–1), `hover_animation`, CSS filters: `css_filters_css_filter:"custom"` + `css_filters_blur`/`css_filters_brightness`/`css_filters_contrast`/`css_filters_saturate`/`css_filters_hue`, border: `image_border_border`/`image_border_width`/`image_border_color`/`image_border_radius`, shadow: `image_box_shadow_box_shadow_type:"yes"` + `image_box_shadow_box_shadow`.

**button** — [Content] `text`, `link`, `size` ("xs"|"sm"|"md"|"lg"|"xl"), `selected_icon`, `icon_align` ("row"=icon first|"row-reverse"), `icon_indent` (slider). [Style] `align`(+resp), `typography_*`, `text_shadow_text_shadow`, `button_text_color`, `background_color`, hover: `hover_color`, `button_background_hover_color`, `button_hover_border_color`, `hover_animation`; border: `border_border`/`border_width`/`border_color`/`border_radius`; `button_box_shadow_box_shadow_type:"yes"` + `button_box_shadow_box_shadow`; `text_padding` (dimensions).

**icon** — [Content] `selected_icon`, `view` ("default"|"stacked"|"framed"), `shape` ("circle"|"square"), `link`, `align`(+resp). [Style] `primary_color`, `secondary_color` (chip bg when stacked / border when framed), `hover_primary_color`, `hover_secondary_color`, `size` (slider — NOT `icon_size`), `icon_padding` (slider, stacked/framed), `rotate` (deg slider), `border_width`/`border_radius` (framed), `hover_animation`.

**icon-box** — [Content] `selected_icon`, `title_text`, `description_text`, `position` ("top"|"left"|"right"), `title_size` ("h1".."h6"…), `link`, `view`/`shape` as icon. [Style] icon: `primary_color`, `secondary_color`, `hover_primary_color`, `hover_secondary_color`, `icon_size` (slider), `icon_space` (icon↔content gap), `rotate`; content: `text_align`(+resp), `content_vertical_alignment` ("top"|"middle"|"bottom"), `title_color`, `title_bottom_space`, `title_typography_*`, `description_color`, `description_typography_*`; `hover_animation`.

**image-box** — [Content] `image`, `title_text`, `description_text`, `title_size`, `link`. [Style] `image_space` (image↔text gap), `image_size` (width % slider), `hover_animation`, css filters (as image: `css_filters_*`), `text_align`, `title_color`, `title_typography_*`, `description_color`, `description_typography_*`.

**icon-list** — [Content] `icon_list:[{_id, text, selected_icon, link}]` (empty icon `{value:"",library:""}` = text-only nav item), `view` ("traditional"|"inline"). [Style] `space_between` (slider), list divider: `divider:"yes"` + `divider_style` ("solid"|"dotted"|"dashed") + `divider_weight` + `divider_color`; icon: `icon_color`, `icon_size`; text: `text_color`, `text_color_hover`, `text_indent`, `icon_typography_*`.

**counter** — [Content] `starting_number`, `ending_number`, `prefix`, `suffix`, `duration` (ms), `thousand_separator:"yes"` (comma by default — omit `thousand_separator_char`; valid overrides only "."|" "|"_"|"'"), `title`. [Style] `number_color`, `typography_*` (styles the NUMBER), `title_color`, `title_typography_*`.

**progress** — [Content] `title`, `progress_type` (""|"info"|"success"|"warning"|"danger"), `percent` ({size,unit:"%"}), `display_percentage:"yes"`, `inner_text`. [Style] `bar_color`, `bar_bg_color`, `bar_height`… prefer `bar_color` + title typography (`title_typography_*`, `title_color`).

**divider** — [Content] `style` ("solid"|"double"|"dotted"|"dashed"|"curly"|"wavy"|"zigzag" — pattern value is "wavy"), `look` ("line"|"line_text"|"line_icon") + `text`/`icon`, `width` (slider %), `align`. [Style] `color`, `weight` (slider), `gap` (slider).

**spacer** — [Content] `space` (slider). One small spacer (16–28px) max between related elements; never stack.

**testimonial** — [Content] `testimonial_content`, `testimonial_image`, `testimonial_name`, `testimonial_job`, `testimonial_image_position` ("aside"|"top"), `testimonial_alignment` ("left"|"center"|"right"), `link`. [Style] `content_content_color`, `content_typography_*`, `image_size`, `image_border_radius`, `name_text_color`, `name_typography_*`, `job_text_color`, `job_typography_*`.

**star-rating** — [Content] `rating_scale` ("5"|"10"), `rating` ({size:4.9}), `star_style` ("star_fontawesome"|"star_unicode"), `unmarked_star_style` ("outline"|"solid"), `title`. [Style] `stars_color`, `stars_unmarked_color`, `star_size`, `star_space`, `title_color`, `title_typography_*`, `title_gap`.

**rating** (newer icon-rating widget) — [Content] `rating_scale` ({size:5}), `rating_value` (number, e.g. 4.5), `rating_icon` ({value:"eicon-star",library:"eicons"}). [Style] `icon_alignment` ("start"|"center"|"end"), `icon_size`, `icon_gap`, `icon_color` (marked), `icon_unmarked_color`.

**tabs** — [Content] `tabs:[{_id, tab_title, tab_content(HTML)}]`, `type` ("horizontal"|"vertical"). [Style] `border_width`, `border_color`, `background_color`, `tab_color`, `tab_active_color`, `tab_typography_*`, `content_color`, `content_typography_*`.

**accordion / toggle** — [Content] `tabs:[{_id, tab_title, tab_content}]`, `selected_icon` (closed, default fas fa-plus), `selected_active_icon` (open), `title_html_tag`. [Style] `border_width`, `border_color`, `title_color`, `title_background`, `tab_active_color`, `title_padding`, `icon_color`, `icon_active_color`, `icon_space`, `content_color`, `content_background_color`, `content_padding`, `title_typography_*`, `content_typography_*`. (Toggle = multiple open at once; accordion = one.)

**alert** — [Content] `alert_type` ("info"|"success"|"warning"|"danger"), `alert_title`, `alert_description`, `show_dismiss` ("show"|""). [Style] `background_color`, `border_color`, `border_left-width` via border keys, `title_color`, `description_color`.

**social-icons** — [Content] `social_icon_list:[{_id, social_icon:{value:"fab fa-instagram",library:"fa-brands"}, link}]`, `shape` ("rounded"|"square"|"circle"), `columns` (0=auto), `align`. [Style] `icon_color:"custom"` + `icon_primary_color` (chip bg) + `icon_secondary_color` (glyph), `hover_primary_color`, `hover_secondary_color`, `icon_size`, `icon_padding`, `icon_spacing`, `border_radius`, `hover_animation`.

**image-carousel** — [Content] `carousel:[{id,url}]` (the array key is `carousel`), `slides_to_show` ("1".."10"), `slides_to_scroll`, `image_stretch:"yes"`, `navigation` ("both"|"arrows"|"dots"|"none"), `link_to`, `caption_type`. [Content>Additional] `autoplay:"yes"`, `autoplay_speed` (ms), `infinite:"yes"`, `pause_on_hover:"yes"`. [Style] `image_spacing:"custom"` + `image_spacing_custom` (slider), `image_border_border`/`image_border_radius`.

**image-gallery** — [Content] `wp_gallery:[{id,url}]` (the array key is `wp_gallery`, NOT `gallery`), `gallery_columns` (1–10), `gallery_link` ("file"|"attachment"|"none"), `gallery_rand`. Renders via the WP [gallery] shortcode from attachment IDs — real sideloaded ids are mandatory (the app fills them in).

**video** — [Content] `video_type` ("youtube"|"vimeo"|"dailymotion"|"hosted"), `youtube_url`/`vimeo_url`/`insert_url:{url}`, `autoplay`/`mute`/`loop`/`controls` ("yes"|""), `start`/`end` (sec), `show_image_overlay:"yes"` + `image_overlay` + `show_play_icon:"yes"`, `lazy_load:"yes"`. [Style] `aspect_ratio` ("169"|"219"|"43"|"32"|"11"|"916"), `play_icon_color`, `play_icon_size`.

**google_maps** — [Content] `address` (plain text), `zoom` ({size:14}), `height` (slider). [Style] `css_filters_*` (grayscale map: `css_filters_css_filter:"custom"` + `css_filters_saturate:{size:0}`).

**menu-anchor** — [Content] `anchor` (lowercase id, no '#'). Invisible; place ONLY where a nav actually links to it — pages without an anchor-linking nav get none.

**text-path** — [Content] `text`, `path` ("wave"|"arc"|"circle"|"line"|"oval"|"spiral"), `align`, `show_path:"yes"`. [Style] `size` (slider), `start_point`, `text_color_normal`, `text_color_hover`, `stroke_color_normal`, `stroke_width_normal`, `text_typography_*`.

<!-- PRO_ONLY_START -->
# PRO WIDGETS (this site has Elementor Pro — prefer these over free fallbacks)

**nav-menu** — [Content] `menu_name` (WP menu; leave default when unknown), `layout` ("horizontal"|"vertical"|"dropdown"), `align_items` ("start"|"center"|"end"|"justify"), `pointer` ("none"|"underline"|"overline"|"double-line"|"framed"|"background"|"text"), `animation_line` ("fade"|"slide"|"grow"|"drop-in"|"drop-out"|"none"), `dropdown` breakpoint ("mobile"|"tablet"|"none"), `toggle:"burger"`. [Style] `color_menu_item`, `color_menu_item_hover`, `pointer_color_menu_item_hover`, `color_menu_item_active`, `pointer_color_menu_item_active`, `padding_horizontal_menu_item`, `padding_vertical_menu_item`, `menu_space_between`, `menu_typography_*`.

**form** — [Content] `form_name`, `form_fields:[{_id, field_type("text"|"email"|"textarea"|"tel"|"select"|"checkbox"|"date"|…), field_label, placeholder, required:"yes", width("100"|"50"|"33"…), field_options}]`, `button_text`, `button_size`, `button_align` ("start"|"center"|"end"|"stretch"), `input_size`, `show_labels:"yes"`, `submit_actions:["email"]`, `email_to`, `success_message`. [Style] `button_background_color`, `button_text_color`, `button_hover_background_color`, `button_hover_color`, `button_typography_*`, field colors/typography via `field_text_color`, `field_background_color`, `field_border_color`, `field_border_radius`, `field_typography_*`, label: `label_text_color`.

**posts** — layout keys are SKIN-PREFIXED (bare `posts_per_page`/`columns` are silently ignored). Classic skin: `posts_post_type:"post"`, `classic_posts_per_page:6` (number), `classic_columns:"3"` (STRING "1".."6"; responsive `classic_columns_tablet`/`classic_columns_mobile`), `classic_thumbnail:"top"`, `classic_show_title:"yes"`, `classic_show_excerpt:"yes"`, `classic_meta_data:["date"]`, `classic_show_read_more:"yes"`, `pagination_type` (""|"numbers"|"prev_next"|"numbers_and_prev_next"|"load_more_on_click"). With `_skin:"cards"` use `cards_*` equivalents. Blog/news/insights sections MUST use this widget — it renders the site's REAL posts; never hand-build fake post cards.

**portfolio** — no skin prefix: `posts_per_page:6`, `columns:3`, `show_filter_bar:"yes"|"no"`, `masonry:"yes"|"no"`, `show_title:"yes"`, `title_tag`, `thumbnail_size_size`. (No pagination controls.)

**slides** — [Content] `slides:[{_id, heading, description, button_text, link, background_color, background_image:{url,id}, background_overlay:"yes", background_overlay_color, background_ken_burns:"yes", zoom_direction, content_animation("fadeInUp"…), horizontal_position, vertical_position, text_align}]`, `navigation`, `autoplay:"yes"`, `autoplay_speed`, `infinite:"yes"`, `transition` ("slide"|"fade"), `slides_height` (slider, resp). [Style] `content_max_width`, `slides_padding`, `heading_color`, `heading_typography_*`, `description_color`, `description_typography_*`, `button_size`, `button_color`, `button_background_color`, `button_border_radius`, `arrows_color`, `dots_color`.

**price-table** — [Content] `heading`, `sub_heading`, `currency_symbol` ("dollar"|"euro"|…|"custom") + `currency_symbol_custom`, `price`, `period`, `sale:"yes"` + `original_price`, `features_list:[{_id, item_text, selected_item_icon, item_icon_color}]`, `button_text`, `link`, `button_size`, `footer_additional_info`, `show_ribbon:"yes"` + `ribbon_title` + `ribbon_horizontal_position`. [Style] `header_bg_color`, `heading_color`, `sub_heading_color`, `pricing_element_bg_color`, `price_color`, `button_background_color`, `button_text_color`, `button_hover_background_color`, `button_hover_color`, `ribbon_bg_color`, `ribbon_text_color`.

**price-list** — [Content] `price_list:[{_id, title, price, item_description, image, link}]`, `title_tag`. [Style] separator style/weight/color, `title_color`, `price_color`, `description_color` + typographies.

**testimonial-carousel** — [Content] `slides:[{_id, content, image, name, title}]`, `skin` ("default"|"bubble"), `layout` ("image_inline"|"image_stacked"|"image_above"|"image_left"|"image_right"), `alignment`, `slides_per_view` ("1".."4"), `autoplay:"yes"`, `navigation`. [Style] `space_between`, `slide_background_color`, `slide_padding`, `slide_border_radius`, `slide_border_border`/`slide_border_width`/`slide_border_color`, `content_color`, `name_color`, `title_color`, `image_size`, `image_gap`, `image_border_radius`, `content_typography_*`, `name_typography_*`.

**media-carousel** — [Content] `skin` ("carousel"|"slideshow"|"coverflow"), `slides:[{_id, image:{url,id}}]`, `effect` ("slide"|"fade"|"cube"), `slides_per_view`, `height`/`width` (sliders), `show_arrows:"yes"`, `pagination` (""|"bullets"|"fraction"|"progressbar"), `autoplay:"yes"`, `loop:"yes"`, `overlay` (""|"text"|"icon"), `caption`. [Style] `space_between`, `slide_background_color`, `slide_border_radius`, `arrows_size`, `arrows_color`.

**call-to-action** — [Content] `title`, `description`, `button`, `link`, `skin` ("classic"|"cover"), `graphic_element` ("none"|"image"|"icon") + `graphic_image`/`selected_icon`, `bg_image:{url,id}` (cover skin), `title_tag`, `ribbon_title`. [Style] overlay: `background_overlay_background:"classic"` + `background_overlay_color`; `title_color`, `description_color`, `button_background_color`, `button_text_color`, `button_hover_background_color`.

**flip-box** — [Content] front: `graphic_element` + `selected_icon`/`image`, `title_text_a`, `description_text_a`; back: `title_text_b`, `description_text_b`, `button_text`, `link`; `flip_effect` ("flip"|"slide"|"push"|"zoom-in"|"zoom-out"|"fade"), `flip_direction` ("left"|"right"|"up"|"down"), `flip_3d:"yes"`, `height` (slider). [Style] `background_color_a`, `title_color_a`, `description_color_a`, `icon_color_a`, `background_color_b`, `title_color_b`, `description_color_b`, `button_background_color`, `button_color`, `border_radius`.

**animated-headline** — [Content] `headline_style` ("highlight"|"rotate"), highlight: `marker` ("circle"|"curly"|"underline"|"double"|"double_underline"|"underline_zigzag"|"diagonal"|"strikethrough"|"x") + `highlighted_text`; rotate: `animation_type` ("typing"|"clip"|"flip"|"swirl"|"blinds"|"drop-in"|"wave"|"slide"|"slide-down") + `rotating_text` (one phrase per line); `before_text`, `after_text`, `tag`. [Style] shape `marker_color`, `headline_color`… style the static and animated fragments separately.

**countdown** — [Content] `countdown_type` ("due_date"|"evergreen"), `due_date` ("Y-m-d H:i"), `evergreen_counter_hours`/`_minutes`, `show_days`/`show_hours`/`show_minutes`/`show_seconds` ("yes"|""), `show_labels:"yes"`, `custom_labels:"yes"` + `label_days`/`label_hours`/`label_minutes`/`label_seconds`, `expire_actions:["hide"|"redirect"|"message"]`. [Style] `digits_color`, `digits_background_color`, `label_color`, `digits_typography_*`.

**share-buttons** — [Content] `share_buttons:[{_id, button:"facebook"|"twitter"|"linkedin"|"pinterest"|"whatsapp"|…}]`, `view` ("icon-text"|"icon"|"text"), `skin` ("gradient"|"minimal"|"framed"|"boxed"|"flat"), `shape` ("square"|"rounded"|"circle"), `columns`. 

**blockquote** — [Content] `blockquote_content`, `author_name`, `blockquote_skin` ("border"|"quotation"|"boxed"|"clean"), `alignment`, optional tweet button (`tweet_button:"yes"`, `tweet_button_view`, `user_name`). [Style] `content_text_color`, `content_typography_*`, `author_text_color`, `author_typography_*`, `border_color`, `border_width`, `box_color` (boxed skin), `quote_size` (quotation skin).

**gallery** (Pro advanced gallery) — [Content] `gallery:[{id,url}]`, `gallery_layout` ("grid"|"justified"|"masonry"), `columns` (int; resp `columns_tablet`/`columns_mobile`), `gap` (slider), `link_to` ("file"|"custom"|"none"), `gallery_type` ("single"|"multiple") + `galleries:[{gallery_title, gallery}]` for a filter bar, `aspect_ratio` ("1:1"|"3:2"|"4:3"|"16:9"|…), `ideal_row_height` (justified), `open_lightbox`, `lazyload:"yes"`. [Style] `overlay_background` (hover overlay), `content_hover_animation`, `image_border_radius`, `image_border_border`/`image_border_width`/`image_border_color`.

**lottie** — [Content] `source` ("external_url"|"media_file") + `source_external_url`/`source_json:{url,id}`, `trigger` ("arriving_to_viewport"|"on_click"|"on_hover"|"bind_to_scroll"|"none"), `loop:"yes"` + `number_of_times`, `play_speed`, `start_point`/`end_point` (0–100), `reverse_animation:"yes"`, `renderer` ("svg"|"canvas"), `link_to:"custom"` + `custom_link`, `caption_source`/`caption`. [Style] `align`, `width` (slider), `opacity` (0–1), `opacity_hover`, `css_filters_*`.

**hotspot** — [Content] `image`, `hotspot:[{_id, hotspot_label, hotspot_icon, hotspot_link, hotspot_offset_x ({size,unit:"%"}), hotspot_offset_y, hotspot_tooltip_content}]`, `tooltip_trigger` ("mouseenter"|"click"|"none"), `tooltip_position` ("top"|"bottom"|"left"|"right"), `tooltip_animation` ("e--animation-fadeIn"|"e--animation-zoomIn"|…), `hotspot_animation` ("none"|"soft-beat"|"expand"|"shadow"), `hotspot_sequenced_animation:"yes"`. [Style] `image_width`, `image_opacity`, `image_border_radius`, `hotspot_color`, `hotspot_background_color`, `hotspot_size`, `hotspot_padding`, `hotspot_border_radius`, `hotspot_box_shadow_box_shadow_type:"yes"` + `hotspot_box_shadow_box_shadow`, `tooltip_text_color`, `tooltip_background_color`, `tooltip_border_radius`, `tooltip_padding`, `tooltip_width`, `tooltip_typography_*`.

**reviews** — [Content] platform-badged review cards (like testimonial-carousel but with `slides:[{_id, content, image, name, title, rating, social_icon}]`), `slides_per_view` (int), `autoplay:"yes"|"no"`, `autoplay_speed`, `loop:"yes"|"no"`, `show_arrows:"yes"|"no"`, `pause_on_hover:"yes"|"no"`.

**table-of-contents** — [Content] `title` (default "Table of Contents"), `headings_by_tags:["h2","h3"]`, `marker_view` ("numbers"|"bullets"|"none"), `hierarchical_view:"yes"`. Auto-builds from the page's headings.

**author-box** — [Content] `show_avatar:"yes"|"no"`, `avatar_size` (int px), `show_name:"yes"|"no"`, `author_name_tag`, `show_biography:"yes"|"no"`, `show_link:"yes"|"no"` + `link_text`, `alignment`. Pulls the page author's WP profile.

**login** — [Content] `show_labels:"yes"|"no"`, `show_remember_me:"yes"|"no"`, `show_lost_password:"yes"|"no"`, `button_text`, `button_size`, `redirect_after_login:"yes"` + `redirect_url`, `align`. Renders a working WP login form.

**search** — [Content] `search_input_placeholder_text`, `submit_trigger` ("button"|"auto"), `submit_button_text`, `live_results:"yes"|"no"` + `number_of_items`, `search_query_post_type`.

**code-highlight** — [Content] `code`, `language` ("php"|"javascript"|"css"|"html"|"python"|"bash"), `theme` ("default"|"dark"|"funky"|"okaidia"|"twilight"|"coy"), `line_numbers:"yes"|"no"`, `copy_to_clipboard:"yes"|"no"`.

**progress-tracker** — [Content] `type` ("horizontal"|"circular"), `relative_to` ("page"|"element"), `align`, `circular_size` (int px), `circular_width` (int px). A scroll-progress indicator.
<!-- PRO_ONLY_END -->

# WIDGETS DELIBERATELY NOT AVAILABLE (from the full dictionary — and why)

These exist in Elementor but are NOT in your whitelist. Never emit them; use the noted alternative:
- **html** — permanently forbidden by the golden rule. Build everything with real widgets.
- **shortcode** — renders only if a matching plugin shortcode exists on the site; guessing one produces broken output. Skip.
- **sidebar / read-more** — depend on theme widget-areas / post-excerpt context; meaningless on a standalone Elementor page.
- **template** — mirrors a saved Elementor template by ID; no way to know the site's template IDs.
- **audio (SoundCloud embed AND the Pro self-hosted MP3/WAV/OGG player) / Facebook page-button-comments-embed** — external embeds/media players; only meaningful when the brief supplies real URLs or files. Skip unless the user explicitly provides them.
- **Theme elements (site-logo, site-title, site-tagline, post-title, post-content, post-excerpt, featured-image, post-info, archive-*, post-navigation, post-comments, breadcrumbs, search-results, sitemap)** — Theme-Builder widgets for header/footer/single/archive templates, not standalone pages. (Meta rows on a standalone page: use `icon-list`.)
- **mega-menu, nested-tabs, nested-accordion, nested-carousel, loop-grid, loop-carousel, off-canvas, lightbox trigger, video-playlist, paypal-button, stripe-button, button-group, "Search Filter" (Pro taxonomies filter), Global Query Controller** — require nested-container editing, loop templates, payment/config setup, or interactive wiring this one-shot pipeline can't provide. A mixed-content carousel → use `slides`/`media-carousel`/`testimonial-carousel`; a mega menu or drawer → approximate with `nav-menu` + containers.
- **WooCommerce widgets (products, add-to-cart, cart, checkout, my-account, product-*)** — need WooCommerce active; not currently whitelisted (can be added on request).

# HOW TO USE THIS KNOWLEDGE (the designer's loop)

For every section of the page: pick the RIGHT widget for the job (don't fake a widget's job with text-editor); fill its [Content] completely with real copy; style every visible part via its [Style] keys to match the reference/brand; then apply the [Advanced] wrapper (spacing, background, border/shadow, entrance animation) so it sits in the layout exactly like the reference. All three tabs, every widget, every time.
