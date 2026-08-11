<?php
/**
 * Plugin Name:       EAI Connector
 * Plugin URI:        https://example.com/eai-connector
 * Description:       Secure REST bridge that lets the AI → Elementor Page Publisher create and edit Elementor pages, including protected _elementor_data. Delivers per-page CSS internally (never via Customizer).
 * Version:           1.4.1
 * Author:            Your Team
 * License:           GPL-2.0-or-later
 * Text Domain:       eai-connector
 *
 * ============================================================
 * OWNER: Person 1 (WordPress Companion Plugin)
 *
 * WHY THIS EXISTS:
 *   `_elementor_data` is protected meta (underscore prefix), so core
 *   WP REST refuses to write it. These custom routes bypass that.
 *   WordPress Application Password auth works with custom routes
 *   automatically — we only add capability checks, never auth logic.
 *
 * INSTALL:
 *   1. Zip this single file (or the folder) and upload via
 *      Plugins → Add New → Upload, then Activate.
 *   2. On the target site create an Application Password:
 *      Users → Profile → Application Passwords.
 *   3. Point the app at {site}/wp-json/eai/v1
 *
 * NAMESPACE: eai/v1
 * ============================================================
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'EAI_CSS_SUBDIR', 'eai-css' );
define( 'EAI_MAX_CSS_BYTES', 51200 );      // 50 KB cap on custom_css
define( 'EAI_RATE_LIMIT_WRITES', 60 );     // max write ops per user per hour
define( 'EAI_MAX_REVISIONS', 10 );         // snapshots kept per page (newest first)

/**
 * ------------------------------------------------------------
 * Route registration
 * ------------------------------------------------------------
 */
add_action( 'rest_api_init', 'eai_register_routes' );

function eai_register_routes() {

	$perm = 'eai_permission_check';

	register_rest_route( 'eai/v1', '/ping', array(
		'methods'             => 'GET',
		'callback'            => 'eai_ping',
		'permission_callback' => $perm,
	) );

	register_rest_route( 'eai/v1', '/pages', array(
		array(
			'methods'             => 'GET',
			'callback'            => 'eai_list_pages',
			'permission_callback' => $perm,
		),
		array(
			'methods'             => 'POST',
			'callback'            => 'eai_save_page',
			'permission_callback' => $perm,
		),
	) );

	register_rest_route( 'eai/v1', '/pages/(?P<id>\d+)', array(
		'methods'             => 'GET',
		'callback'            => 'eai_get_page',
		'permission_callback' => $perm,
		'args'                => array(
			'id' => array(
				'validate_callback' => function ( $param ) {
					return is_numeric( $param );
				},
			),
		),
	) );

	register_rest_route( 'eai/v1', '/media/sideload', array(
		'methods'             => 'POST',
		'callback'            => 'eai_sideload_media',
		'permission_callback' => $perm,
	) );

	register_rest_route( 'eai/v1', '/globals', array(
		'methods'             => 'GET',
		'callback'            => 'eai_get_globals',
		'permission_callback' => $perm,
	) );

	register_rest_route( 'eai/v1', '/templates', array(
		array(
			'methods'             => 'GET',
			'callback'            => 'eai_list_templates',
			'permission_callback' => $perm,
		),
		array(
			'methods'             => 'POST',
			'callback'            => 'eai_create_template',
			'permission_callback' => $perm,
		),
	) );

	register_rest_route( 'eai/v1', '/globals/widgets', array(
		array(
			'methods'             => 'GET',
			'callback'            => 'eai_list_global_widgets',
			'permission_callback' => $perm,
		),
		array(
			'methods'             => 'POST',
			'callback'            => 'eai_create_global_widget',
			'permission_callback' => $perm,
		),
	) );
}

/**
 * ------------------------------------------------------------
 * Permission callback — capability check only.
 * Auth itself is handled by WordPress (Application Passwords).
 * ------------------------------------------------------------
 */
function eai_permission_check() {
	if ( ! current_user_can( 'edit_pages' ) ) {
		return new WP_Error(
			'eai_forbidden',
			__( 'You do not have permission to edit pages.', 'eai-connector' ),
			array( 'status' => 403 )
		);
	}
	return true;
}

/**
 * ------------------------------------------------------------
 * GET /ping — capability + environment probe
 * ------------------------------------------------------------
 */
function eai_ping( WP_REST_Request $request ) {
	return new WP_REST_Response( array(
		'ok'                => true,
		'plugin_version'    => '1.4.0',
		'wp_version'        => get_bloginfo( 'version' ),
		'elementor_active'  => defined( 'ELEMENTOR_VERSION' ),
		'elementor_version' => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
		'elementor_pro'     => defined( 'ELEMENTOR_PRO_VERSION' ),
	), 200 );
}

/**
 * ------------------------------------------------------------
 * GET /pages — list pages for the edit-mode dropdown
 * ------------------------------------------------------------
 */
function eai_list_pages( WP_REST_Request $request ) {
	$pages = get_posts( array(
		'post_type'   => 'page',
		'post_status' => array( 'publish', 'draft', 'private' ),
		'numberposts' => 100,
		'orderby'     => 'modified',
		'order'       => 'DESC',
	) );

	$out = array();
	foreach ( $pages as $p ) {
		$out[] = array(
			'id'     => $p->ID,
			'title'  => get_the_title( $p ),
			'status' => $p->post_status,
			'link'   => get_permalink( $p ),
			'built_with_elementor' => (bool) get_post_meta( $p->ID, '_elementor_edit_mode', true ),
		);
	}

	return new WP_REST_Response( $out, 200 );
}

/**
 * ------------------------------------------------------------
 * GET /pages/{id} — read current Elementor state (edit mode)
 * ------------------------------------------------------------
 */
function eai_get_page( WP_REST_Request $request ) {
	$id = (int) $request['id'];

	if ( 'page' !== get_post_type( $id ) ) {
		return new WP_Error( 'eai_not_found', __( 'Page not found.', 'eai-connector' ), array( 'status' => 404 ) );
	}

	$raw  = get_post_meta( $id, '_elementor_data', true );
	$data = $raw ? json_decode( $raw, true ) : array();

	// Raw post content + source-builder detection so non-Elementor pages
	// (Divi / WPBakery / Gutenberg / classic) can be MIGRATED: the app feeds
	// the legacy markup to the model and rebuilds it as native Elementor.
	$post         = get_post( $id );
	$post_content = $post ? (string) $post->post_content : '';
	$builder      = 'none';
	if ( ! empty( $data ) ) {
		$builder = 'elementor';
	} elseif ( false !== strpos( $post_content, '[et_pb_' ) ) {
		$builder = 'divi';
	} elseif ( false !== strpos( $post_content, '[vc_row' ) ) {
		$builder = 'wpbakery';
	} elseif ( false !== strpos( $post_content, '<!-- wp:' ) ) {
		$builder = 'gutenberg';
	} elseif ( '' !== trim( $post_content ) ) {
		$builder = 'classic';
	}

	return new WP_REST_Response( array(
		'id'             => $id,
		'title'          => get_the_title( $id ),
		'status'         => get_post_status( $id ),
		'elementor_data' => $data,
		'page_settings'  => get_post_meta( $id, '_elementor_page_settings', true ),
		'custom_css'     => eai_read_page_css( $id ),
		'link'           => get_permalink( $id ),
		'post_content'   => $post_content,
		'builder'        => $builder,
	), 200 );
}

/**
 * ------------------------------------------------------------
 * POST /pages — create or update an Elementor page
 *
 * Body:
 *   page_id?        int      (present = update, absent = create)
 *   title?          string
 *   status?         string   publish | draft   (default draft)
 *   template?       string   elementor_canvas | elementor_header_footer | default
 *   elementor_data  array    the sections array (REQUIRED)
 *   page_settings   object
 *   custom_css      string
 * ------------------------------------------------------------
 */
function eai_save_page( WP_REST_Request $request ) {

	// --- rate limit (per user, hourly) ---
	if ( ! eai_check_rate_limit() ) {
		return new WP_Error( 'eai_rate_limited', __( 'Write rate limit reached. Try again later.', 'eai-connector' ), array( 'status' => 429 ) );
	}

	$body = $request->get_json_params();
	if ( ! is_array( $body ) ) {
		return new WP_Error( 'eai_bad_body', __( 'Invalid JSON body.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$elementor_data = isset( $body['elementor_data'] ) ? $body['elementor_data'] : null;
	if ( ! is_array( $elementor_data ) ) {
		return new WP_Error( 'eai_missing_data', __( 'elementor_data must be an array.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$page_id       = isset( $body['page_id'] ) ? (int) $body['page_id'] : 0;
	$title         = isset( $body['title'] ) ? sanitize_text_field( $body['title'] ) : 'AI Generated Page';
	$status        = ( isset( $body['status'] ) && 'publish' === $body['status'] ) ? 'publish' : 'draft';
	$template      = isset( $body['template'] ) ? sanitize_text_field( $body['template'] ) : '';
	$page_settings = isset( $body['page_settings'] ) && is_array( $body['page_settings'] ) ? $body['page_settings'] : array();
	$custom_css    = isset( $body['custom_css'] ) ? (string) $body['custom_css'] : '';

	// --- create or update the post shell ---
	if ( $page_id > 0 ) {
		if ( 'page' !== get_post_type( $page_id ) ) {
			return new WP_Error( 'eai_not_found', __( 'Target page not found.', 'eai-connector' ), array( 'status' => 404 ) );
		}
		// Snapshot the current state BEFORE any new meta is written, so the
		// edit can be rolled back from Tools → EAI History.
		eai_snapshot_revision( $page_id );
		$post_args = array( 'ID' => $page_id, 'post_status' => $status );
		if ( isset( $body['title'] ) ) {
			$post_args['post_title'] = $title;
		}
		$result = wp_update_post( $post_args, true );
	} else {
		$result = wp_insert_post( array(
			'post_title'   => $title,
			'post_status'  => $status,
			'post_type'    => 'page',
			'post_content' => '', // Elementor renders from meta, not post_content
		), true );
	}

	if ( is_wp_error( $result ) ) {
		return new WP_Error( 'eai_save_failed', $result->get_error_message(), array( 'status' => 500 ) );
	}

	$post_id = (int) ( $page_id > 0 ? $page_id : $result );

	// --- Elementor Pro? route custom CSS into native page settings ---
	$is_pro = defined( 'ELEMENTOR_PRO_VERSION' );
	$clean_css = eai_sanitize_css( $custom_css );

	if ( $is_pro && '' !== $clean_css ) {
		$page_settings['custom_css'] = $clean_css;
	}

	// --- write the Elementor meta (SLASHING IS CRITICAL) ---
	update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( $elementor_data ) ) );
	update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
	update_post_meta( $post_id, '_elementor_template_type', 'wp-page' );
	if ( defined( 'ELEMENTOR_VERSION' ) ) {
		update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );
	}
	update_post_meta( $post_id, '_elementor_page_settings', $page_settings );

	if ( ! empty( $template ) ) {
		// Map friendly names to Elementor's template slugs.
		$map = array(
			'canvas'                   => 'elementor_canvas',
			'elementor_canvas'         => 'elementor_canvas',
			'full_width'               => 'elementor_header_footer',
			'elementor_header_footer'  => 'elementor_header_footer',
			'default'                  => '', // theme default
		);
		$tpl = isset( $map[ $template ] ) ? $map[ $template ] : $template;
		if ( '' === $tpl ) {
			delete_post_meta( $post_id, '_wp_page_template' );
		} else {
			update_post_meta( $post_id, '_wp_page_template', $tpl );
		}
	}

	// --- free Elementor: deliver CSS as a per-page file (never Customizer) ---
	if ( ! $is_pro ) {
		eai_write_page_css( $post_id, $clean_css );
	}

	// --- regenerate Elementor's own CSS cache for this page ---
	eai_regenerate_elementor_css( $post_id );

	return new WP_REST_Response( array(
		'ok'          => true,
		'id'          => $post_id,
		'link'        => get_permalink( $post_id ),
		'editor_link' => admin_url( 'post.php?post=' . $post_id . '&action=elementor' ),
		'status'      => get_post_status( $post_id ),
	), 200 );
}

/**
 * ------------------------------------------------------------
 * POST /media/sideload — pull an external image into the Media Library
 * ------------------------------------------------------------
 */
function eai_sideload_media( WP_REST_Request $request ) {
	$body = $request->get_json_params();
	$url  = isset( $body['url'] ) ? esc_url_raw( $body['url'] ) : '';

	if ( empty( $url ) ) {
		return new WP_Error( 'eai_no_url', __( 'No url provided.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	require_once ABSPATH . 'wp-admin/includes/media.php';
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/image.php';

	// Download first, then sideload with an explicit filename: stock URLs like
	// images.unsplash.com/photo-XXXX?w=1400 carry NO file extension, which
	// makes media_sideload_image() reject them outright.
	$tmp = download_url( $url, 30 );
	if ( is_wp_error( $tmp ) ) {
		return new WP_Error( 'eai_sideload_failed', $tmp->get_error_message(), array( 'status' => 502 ) );
	}

	$ext  = 'jpg';
	$mime = function_exists( 'wp_get_image_mime' ) ? wp_get_image_mime( $tmp ) : '';
	$map  = array(
		'image/jpeg'    => 'jpg',
		'image/png'     => 'png',
		'image/webp'    => 'webp',
		'image/gif'     => 'gif',
		'image/avif'    => 'avif',
	);
	if ( $mime && isset( $map[ $mime ] ) ) {
		$ext = $map[ $mime ];
	} else {
		$path_ext = strtolower( pathinfo( wp_parse_url( $url, PHP_URL_PATH ), PATHINFO_EXTENSION ) );
		if ( in_array( $path_ext, $map, true ) ) {
			$ext = $path_ext;
		}
	}

	$file_array = array(
		'name'     => 'eai-' . substr( md5( $url ), 0, 10 ) . '.' . $ext,
		'tmp_name' => $tmp,
	);

	$attachment_id = media_handle_sideload( $file_array, 0 );

	if ( is_wp_error( $attachment_id ) ) {
		@unlink( $tmp );
		return new WP_Error( 'eai_sideload_failed', $attachment_id->get_error_message(), array( 'status' => 502 ) );
	}

	return new WP_REST_Response( array(
		'id'  => (int) $attachment_id,
		'url' => wp_get_attachment_url( (int) $attachment_id ),
	), 200 );
}

/**
 * ------------------------------------------------------------
 * GET /globals — read the active kit's global colors & typography
 *
 * Soft-missing convention: if no active kit exists we still 200
 * with active_kit_id 0 and empty arrays so the backend can proceed.
 * ------------------------------------------------------------
 */
function eai_get_globals( WP_REST_Request $request ) {
	$kit_id = (int) get_option( 'elementor_active_kit' );

	// 1) Preferred: ask Elementor's Kit object, which MERGES control defaults —
	// raw post meta is empty until the user saves Site Settings at least once,
	// which made this endpoint return empty lists on fresh sites.
	$settings = array();
	if ( class_exists( '\Elementor\Plugin' ) ) {
		try {
			$kits_manager = \Elementor\Plugin::$instance->kits_manager;
			$kit          = $kits_manager ? $kits_manager->get_active_kit() : null;
			if ( $kit && method_exists( $kit, 'get_settings' ) ) {
				$kit_settings = $kit->get_settings();
				if ( is_array( $kit_settings ) ) {
					$settings = $kit_settings;
				}
			}
		} catch ( \Throwable $e ) {
			$settings = array();
		}
	}

	// 2) Fallback: raw kit meta (covers older Elementor versions).
	if ( empty( $settings['system_colors'] ) && $kit_id ) {
		$meta = get_post_meta( $kit_id, '_elementor_page_settings', true );
		if ( is_array( $meta ) ) {
			$settings = array_merge( $meta, array_filter( $settings ) );
		}
	}

	// 3) Last resort: Elementor's documented default global palette, so the
	// endpoint is NEVER empty on a working Elementor site.
	if ( empty( $settings['system_colors'] ) ) {
		$settings['system_colors'] = array(
			array( '_id' => 'primary', 'title' => 'Primary', 'color' => '#6EC1E4' ),
			array( '_id' => 'secondary', 'title' => 'Secondary', 'color' => '#54595F' ),
			array( '_id' => 'text', 'title' => 'Text', 'color' => '#7A7A7A' ),
			array( '_id' => 'accent', 'title' => 'Accent', 'color' => '#61CE70' ),
		);
	}
	if ( empty( $settings['system_typography'] ) ) {
		$settings['system_typography'] = array(
			array( '_id' => 'primary', 'title' => 'Primary', 'typography_font_family' => 'Roboto', 'typography_font_weight' => '600' ),
			array( '_id' => 'secondary', 'title' => 'Secondary', 'typography_font_family' => 'Roboto Slab', 'typography_font_weight' => '400' ),
			array( '_id' => 'text', 'title' => 'Text', 'typography_font_family' => 'Roboto', 'typography_font_weight' => '400' ),
			array( '_id' => 'accent', 'title' => 'Accent', 'typography_font_family' => 'Roboto', 'typography_font_weight' => '500' ),
		);
	}

	$color_keys      = array( '_id', 'title', 'color' );
	$typography_keys = array( '_id', 'title', 'typography_font_family', 'typography_font_weight' );

	return new WP_REST_Response( array(
		'active_kit_id'     => $kit_id,
		'system_colors'     => eai_sanitize_global_items( $settings, 'system_colors', $color_keys ),
		'custom_colors'     => eai_sanitize_global_items( $settings, 'custom_colors', $color_keys ),
		'system_typography' => eai_sanitize_global_items( $settings, 'system_typography', $typography_keys ),
		'custom_typography' => eai_sanitize_global_items( $settings, 'custom_typography', $typography_keys ),
	), 200 );
}

/**
 * ------------------------------------------------------------
 * GET /globals/widgets — list Elementor Pro GLOBAL WIDGETS
 * (elementor_library posts of template type "widget"). Embedding
 * one in a page uses widgetType "global" + templateID; Elementor
 * auto-syncs every page when the global widget changes.
 * ------------------------------------------------------------
 */
function eai_list_global_widgets( WP_REST_Request $request ) {
	if ( ! defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		return new WP_REST_Response( array(
			'available' => false,
			'widgets'   => array(),
			'message'   => 'Global widgets require Elementor Pro.',
		), 200 );
	}

	$posts = get_posts( array(
		'post_type'   => 'elementor_library',
		'post_status' => 'publish',
		'numberposts' => 100,
		'meta_key'    => '_elementor_template_type',
		'meta_value'  => 'widget',
	) );

	$out = array();
	foreach ( $posts as $p ) {
		$out[] = array(
			'id'    => $p->ID,
			'title' => get_the_title( $p ),
		);
	}

	return new WP_REST_Response( array(
		'available' => true,
		'widgets'   => $out,
	), 200 );
}

/**
 * ------------------------------------------------------------
 * POST /globals/widgets — create a GLOBAL WIDGET from an element
 * Body: { title: string, element: object }
 * A true Elementor global widget wraps a SINGLE widget element;
 * a container holding exactly one widget is unwrapped automatically.
 * ------------------------------------------------------------
 */
function eai_create_global_widget( WP_REST_Request $request ) {
	if ( ! defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		return new WP_Error( 'eai_pro_required', __( 'Global widgets require Elementor Pro.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$body = $request->get_json_params();
	if ( ! is_array( $body ) || empty( $body['element'] ) || ! is_array( $body['element'] ) ) {
		return new WP_Error( 'eai_bad_body', __( 'element (an Elementor element object) is required.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$element = $body['element'];

	// Unwrap a container/column that holds exactly one widget.
	while ( isset( $element['elType'] ) && 'widget' !== $element['elType']
		&& isset( $element['elements'] ) && is_array( $element['elements'] )
		&& 1 === count( $element['elements'] ) ) {
		$element = $element['elements'][0];
	}

	if ( ! isset( $element['elType'] ) || 'widget' !== $element['elType'] ) {
		return new WP_Error(
			'eai_not_a_widget',
			__( 'Global widgets can only be made from a SINGLE widget. This block contains multiple elements — save it in the component library instead.', 'eai-connector' ),
			array( 'status' => 400 )
		);
	}

	$title = isset( $body['title'] ) && '' !== trim( (string) $body['title'] )
		? sanitize_text_field( $body['title'] )
		: 'EAI Global Widget';

	$post_id = wp_insert_post( array(
		'post_title'  => $title,
		'post_type'   => 'elementor_library',
		'post_status' => 'publish',
	), true );

	if ( is_wp_error( $post_id ) ) {
		return $post_id;
	}

	update_post_meta( $post_id, '_elementor_template_type', 'widget' );
	update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
	// SLASHING IS CRITICAL — see eai_save_page.
	update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( array( $element ) ) ) );

	return new WP_REST_Response( array(
		'id'    => $post_id,
		'title' => $title,
	), 200 );
}

/**
 * ------------------------------------------------------------
 * GET /templates?type=loop-item — list library templates of a type.
 * ------------------------------------------------------------
 */
function eai_list_templates( WP_REST_Request $request ) {
	$type = sanitize_key( $request->get_param( 'type' ) );
	if ( '' === $type ) {
		$type = 'loop-item';
	}
	$posts = get_posts( array(
		'post_type'      => 'elementor_library',
		'post_status'    => 'publish',
		'posts_per_page' => 50,
		'meta_key'       => '_elementor_template_type',
		'meta_value'     => $type,
		'orderby'        => 'date',
		'order'          => 'DESC',
	) );
	$out = array();
	foreach ( $posts as $p ) {
		$out[] = array( 'id' => $p->ID, 'title' => $p->post_title );
	}
	return new WP_REST_Response( $out, 200 );
}

/**
 * ------------------------------------------------------------
 * POST /templates — create an Elementor library template
 * programmatically (loop-item for custom blog cards).
 * Body: { title, type: 'loop-item', content: [ <element> ] }
 * Meta requirements verified against Elementor source:
 *   _elementor_edit_mode = 'builder'  (REQUIRED for frontend render)
 *   _elementor_template_type = type
 *   _elementor_data = wp_slash(json)  (slashing critical)
 * + the elementor_library_type taxonomy term (admin/library listing).
 * ------------------------------------------------------------
 */
function eai_create_template( WP_REST_Request $request ) {
	if ( ! defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		return new WP_Error( 'eai_pro_required', __( 'Loop templates require Elementor Pro.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$body = $request->get_json_params();
	if ( ! is_array( $body ) || empty( $body['content'] ) || ! is_array( $body['content'] ) ) {
		return new WP_Error( 'eai_bad_body', __( 'content (an Elementor elements array) is required.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$allowed_types = array( 'loop-item' );
	$type = isset( $body['type'] ) ? sanitize_key( $body['type'] ) : 'loop-item';
	if ( ! in_array( $type, $allowed_types, true ) ) {
		return new WP_Error( 'eai_bad_type', __( 'Unsupported template type.', 'eai-connector' ), array( 'status' => 400 ) );
	}

	$title = isset( $body['title'] ) && '' !== trim( (string) $body['title'] )
		? sanitize_text_field( $body['title'] )
		: 'EAI Loop Card';

	$post_id = wp_insert_post( array(
		'post_title'  => $title,
		'post_type'   => 'elementor_library',
		'post_status' => 'publish',
	), true );

	if ( is_wp_error( $post_id ) ) {
		return $post_id;
	}

	update_post_meta( $post_id, '_elementor_template_type', $type );
	update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
	if ( defined( 'ELEMENTOR_VERSION' ) ) {
		update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );
	}
	// SLASHING IS CRITICAL — see eai_save_page.
	update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( $body['content'] ) ) );
	wp_set_object_terms( $post_id, $type, 'elementor_library_type' );

	// Rebuild CSS + clear stale asset cache exactly like pages.
	eai_regenerate_elementor_css( $post_id );

	return new WP_REST_Response( array(
		'id'    => $post_id,
		'title' => $title,
		'type'  => $type,
	), 200 );
}

/**
 * ============================================================
 * Helpers
 * ============================================================
 */

/**
 * Reduce a kit globals list (colors/typography) to a lean,
 * sanitized whitelist of keys. Returns a re-indexed array.
 */
function eai_sanitize_global_items( $settings, $key, $allowed_keys ) {
	if ( ! isset( $settings[ $key ] ) || ! is_array( $settings[ $key ] ) ) {
		return array();
	}

	$out = array();
	foreach ( array_values( $settings[ $key ] ) as $item ) {
		if ( ! is_array( $item ) ) {
			continue;
		}
		$clean = array();
		foreach ( $allowed_keys as $allowed ) {
			if ( isset( $item[ $allowed ] ) && is_scalar( $item[ $allowed ] ) ) {
				$clean[ $allowed ] = sanitize_text_field( (string) $item[ $allowed ] );
			}
		}
		$out[] = $clean;
	}
	return $out;
}

/**
 * Snapshot a page's current Elementor state into '_eai_revisions'
 * (newest first, capped at EAI_MAX_REVISIONS). Skipped when the page
 * has no _elementor_data yet — there is nothing worth restoring.
 */
function eai_snapshot_revision( $post_id ) {
	$raw = get_post_meta( $post_id, '_elementor_data', true );
	if ( ! is_string( $raw ) || '' === $raw ) {
		return;
	}

	$revisions = get_post_meta( $post_id, '_eai_revisions', true );
	if ( ! is_array( $revisions ) ) {
		$revisions = array();
	}

	array_unshift( $revisions, array(
		'ts'       => current_time( 'mysql' ),
		'title'    => get_the_title( $post_id ),
		'data'     => $raw, // raw JSON string, exactly as stored
		'settings' => get_post_meta( $post_id, '_elementor_page_settings', true ),
		'css'      => eai_read_page_css( $post_id ),
	) );

	$revisions = array_slice( $revisions, 0, EAI_MAX_REVISIONS );

	// SLASHING IS CRITICAL: update_post_meta() unslashes, which would
	// corrupt the escaped JSON stored inside each snapshot.
	update_post_meta( $post_id, '_eai_revisions', wp_slash( $revisions ) );
}

/**
 * Regenerate the per-post Elementor CSS file and clear caches.
 * Wrapped defensively in case Elementor internals change.
 */
function eai_regenerate_elementor_css( $post_id ) {
	try {
		// CRITICAL for carousel/slider widgets: Elementor caches the page's
		// required assets (e-swiper CSS/JS, lightbox, …) in _elementor_page_assets
		// at editor-save time. Pages written via REST never rebuild it, so
		// swiper-based widgets (testimonial-carousel, media-carousel, slides,
		// image-carousel) rendered as bare giant arrows with invisible slides.
		// Deleting the meta forces Elementor to re-detect assets on next render.
		delete_post_meta( $post_id, '_elementor_page_assets' );
		delete_post_meta( $post_id, '_elementor_css' );
		if ( class_exists( '\Elementor\Core\Files\CSS\Post' ) ) {
			$css = \Elementor\Core\Files\CSS\Post::create( $post_id );
			$css->update();
		}
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}
	} catch ( \Throwable $e ) {
		// Non-fatal: the page still renders; CSS regenerates on next Elementor save.
		error_log( 'EAI Connector: CSS regen skipped — ' . $e->getMessage() );
	}
}

/**
 * Strip anything dangerous from incoming custom CSS and cap its size.
 */
function eai_sanitize_css( $css ) {
	if ( ! is_string( $css ) || '' === trim( $css ) ) {
		return '';
	}
	$css = str_ireplace( array( '</style', '<script', '</script', 'expression(', '@import', 'javascript:' ), '', $css );
	if ( strlen( $css ) > EAI_MAX_CSS_BYTES ) {
		$css = substr( $css, 0, EAI_MAX_CSS_BYTES );
	}
	return $css;
}

/**
 * Free-Elementor CSS delivery: write uploads/eai-css/page-{id}.css
 */
function eai_write_page_css( $post_id, $css ) {
	$upload = wp_upload_dir();
	$dir    = trailingslashit( $upload['basedir'] ) . EAI_CSS_SUBDIR;

	if ( ! file_exists( $dir ) ) {
		wp_mkdir_p( $dir );
	}

	$file = trailingslashit( $dir ) . 'page-' . $post_id . '.css';

	if ( '' === $css ) {
		if ( file_exists( $file ) ) {
			@unlink( $file );
		}
		return;
	}

	// Prefer WP_Filesystem when available; fall back to file_put_contents.
	if ( function_exists( 'WP_Filesystem' ) ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
		global $wp_filesystem;
		if ( WP_Filesystem() && $wp_filesystem ) {
			$wp_filesystem->put_contents( $file, $css, FS_CHMOD_FILE );
			return;
		}
	}
	@file_put_contents( $file, $css );
}

/**
 * Read the per-page CSS back (for edit-mode GET).
 */
function eai_read_page_css( $post_id ) {
	if ( defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		$settings = get_post_meta( $post_id, '_elementor_page_settings', true );
		return is_array( $settings ) && isset( $settings['custom_css'] ) ? $settings['custom_css'] : '';
	}
	$upload = wp_upload_dir();
	$file   = trailingslashit( $upload['basedir'] ) . EAI_CSS_SUBDIR . '/page-' . $post_id . '.css';
	return file_exists( $file ) ? file_get_contents( $file ) : '';
}

/**
 * Enqueue the per-page CSS file on the front end (free Elementor path).
 * filemtime() version string busts cache on every regeneration.
 */
add_action( 'wp_enqueue_scripts', 'eai_enqueue_page_css' );

function eai_enqueue_page_css() {
	if ( ! is_singular() ) {
		return;
	}
	$id     = get_the_ID();
	$upload = wp_upload_dir();
	$file   = trailingslashit( $upload['basedir'] ) . EAI_CSS_SUBDIR . '/page-' . $id . '.css';

	if ( file_exists( $file ) ) {
		wp_enqueue_style(
			'eai-page-' . $id,
			trailingslashit( $upload['baseurl'] ) . EAI_CSS_SUBDIR . '/page-' . $id . '.css',
			array(),
			filemtime( $file )
		);
	}
}

/**
 * Simple per-user hourly write rate limit using a transient counter.
 */
function eai_check_rate_limit() {
	$user_id = get_current_user_id();
	if ( ! $user_id ) {
		return true; // capability check already gates this
	}
	$key   = 'eai_rl_' . $user_id;
	$count = (int) get_transient( $key );
	if ( $count >= EAI_RATE_LIMIT_WRITES ) {
		return false;
	}
	set_transient( $key, $count + 1, HOUR_IN_SECONDS );
	return true;
}

/**
 * ============================================================
 * Tools → EAI History — browse and restore '_eai_revisions'
 * ============================================================
 */

add_action( 'admin_menu', 'eai_register_history_page' );

function eai_register_history_page() {
	add_submenu_page(
		'tools.php',
		__( 'EAI History', 'eai-connector' ),
		__( 'EAI History', 'eai-connector' ),
		'edit_pages',
		'eai-history',
		'eai_render_history_page'
	);
}

/**
 * Handle a restore POST from the History screen.
 * Returns '' (nothing to do), a success message, or WP_Error.
 */
function eai_handle_history_restore() {
	if ( ! isset( $_POST['eai_restore_page'], $_POST['eai_restore_index'] ) ) {
		return '';
	}

	$page_id = (int) $_POST['eai_restore_page'];
	$index   = (int) $_POST['eai_restore_index'];

	check_admin_referer( 'eai_restore_' . $page_id . '_' . $index );

	if ( ! current_user_can( 'edit_pages' ) ) {
		return new WP_Error( 'eai_forbidden', __( 'You do not have permission to edit pages.', 'eai-connector' ) );
	}

	if ( 'page' !== get_post_type( $page_id ) ) {
		return new WP_Error( 'eai_not_found', __( 'Target page not found.', 'eai-connector' ) );
	}

	$revisions = get_post_meta( $page_id, '_eai_revisions', true );
	if ( ! is_array( $revisions ) || ! isset( $revisions[ $index ] ) || ! is_array( $revisions[ $index ] ) ) {
		return new WP_Error( 'eai_no_revision', __( 'Revision not found.', 'eai-connector' ) );
	}

	$rev      = $revisions[ $index ];
	$raw      = isset( $rev['data'] ) ? (string) $rev['data'] : '';
	$settings = isset( $rev['settings'] ) && is_array( $rev['settings'] ) ? $rev['settings'] : array();
	$css      = isset( $rev['css'] ) ? (string) $rev['css'] : '';

	// Snapshot the CURRENT state first, so the restore itself can be undone.
	eai_snapshot_revision( $page_id );

	// --- write the stored state back (SLASHING IS CRITICAL) ---
	update_post_meta( $page_id, '_elementor_data', wp_slash( $raw ) );
	update_post_meta( $page_id, '_elementor_page_settings', wp_slash( $settings ) );

	// Free Elementor keeps custom CSS in a per-page file; Pro carries it
	// inside the page settings restored above (mirrors eai_save_page).
	if ( ! defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		eai_write_page_css( $page_id, $css );
	}
	eai_regenerate_elementor_css( $page_id );

	$ts = isset( $rev['ts'] ) ? (string) $rev['ts'] : __( 'unknown time', 'eai-connector' );
	/* translators: %s: revision timestamp (MySQL format) */
	return sprintf( __( 'Restored revision from %s', 'eai-connector' ), $ts );
}

/**
 * Build one self-contained restore <form> (nonce + hidden fields).
 * Returned as a string so it can drop into table cells or headings.
 */
function eai_history_restore_form( $page_id, $index, $label, $classes ) {
	$form  = '<form method="post" style="display:inline;margin:0;">';
	$form .= wp_nonce_field( 'eai_restore_' . (int) $page_id . '_' . (int) $index, '_wpnonce', true, false );
	$form .= '<input type="hidden" name="eai_restore_page" value="' . (int) $page_id . '" />';
	$form .= '<input type="hidden" name="eai_restore_index" value="' . (int) $index . '" />';
	$form .= '<button type="submit" class="' . esc_attr( $classes ) . '">' . esc_html( $label ) . '</button>';
	$form .= '</form>';
	return $form;
}

function eai_render_history_page() {
	$notice = eai_handle_history_restore();

	echo '<div class="wrap">';
	echo '<h1>' . esc_html__( 'EAI History', 'eai-connector' ) . '</h1>';

	if ( is_wp_error( $notice ) ) {
		echo '<div class="notice notice-error"><p>' . esc_html( $notice->get_error_message() ) . '</p></div>';
	} elseif ( '' !== $notice ) {
		echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( $notice ) . '</p></div>';
	}

	$pages = get_posts( array(
		'post_type'   => 'page',
		'post_status' => 'any',
		'numberposts' => -1,
		'orderby'     => 'modified',
		'order'       => 'DESC',
		'meta_query'  => array(
			array(
				'key'     => '_eai_revisions',
				'compare' => 'EXISTS',
			),
		),
	) );

	if ( empty( $pages ) ) {
		echo '<p>' . esc_html__( 'No pages with EAI revisions yet. A snapshot is captured automatically each time the AI updates an existing page.', 'eai-connector' ) . '</p>';
		echo '</div>';
		return;
	}

	foreach ( $pages as $page ) {
		$revisions = get_post_meta( $page->ID, '_eai_revisions', true );
		if ( ! is_array( $revisions ) || empty( $revisions ) ) {
			continue;
		}

		echo '<h2 style="margin-bottom:4px;">' . esc_html( get_the_title( $page ) ) . ' <span style="font-weight:normal;color:#646970;">#' . (int) $page->ID . ' — ' . esc_html( $page->post_status ) . '</span></h2>';

		// One-click rollback of the most recent AI edit (revision 0).
		echo eai_history_restore_form( $page->ID, 0, __( 'Undo last AI edit', 'eai-connector' ), 'button button-primary' );

		echo '<table class="widefat striped" style="max-width:900px;margin:12px 0 32px;">';
		echo '<thead><tr>';
		echo '<th>' . esc_html__( 'Saved at', 'eai-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Title', 'eai-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Sections', 'eai-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Action', 'eai-connector' ) . '</th>';
		echo '</tr></thead><tbody>';

		foreach ( $revisions as $index => $rev ) {
			if ( ! is_array( $rev ) ) {
				continue;
			}
			$sections = isset( $rev['data'] ) ? json_decode( (string) $rev['data'], true ) : null;
			echo '<tr>';
			echo '<td>' . esc_html( isset( $rev['ts'] ) ? (string) $rev['ts'] : '' ) . '</td>';
			echo '<td>' . esc_html( isset( $rev['title'] ) ? (string) $rev['title'] : '' ) . '</td>';
			echo '<td>' . (int) ( is_array( $sections ) ? count( $sections ) : 0 ) . '</td>';
			echo '<td>' . eai_history_restore_form( $page->ID, (int) $index, __( 'Restore', 'eai-connector' ), 'button' ) . '</td>';
			echo '</tr>';
		}

		echo '</tbody></table>';
	}

	echo '</div>';
}
