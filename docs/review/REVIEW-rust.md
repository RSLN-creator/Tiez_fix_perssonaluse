# TieZ Clipboard Manager — Rust Backend Code Review

**Scope:** `src-tauri\src` (46 files, ~24,000 LOC), `src-tauri\Cargo.toml`
**Date:** 2026-10-17
**Method:** Every file read in full; cross-cutting greps for `unsafe`, `.unwrap()`, SQL, process spawning, TODO/FIXME, and comment language.
All line numbers verified against the current sources.

---

## 1. Executive Summary

The codebase is a mature, Windows-centric Tauri 2 clipboard manager. The best-written parts are the
repositories (`infrastructure\repository\*`) and the clipboard pipeline (`services\clipboard\pipeline.rs`),
which show real engineering discipline: documented rationale comments, measured performance notes
(e.g. the FTS5 trigram search migration in `infrastructure\repository\migrations.rs:201-210` and
`clipboard_repo.rs:355-380`), and a good test suite (`clipboard_repo.rs:1507-2021`).

The dominant structural problems are:

1. **Layering is inverted in several places.** Infrastructure and services import from
   `app\commands\*` (`drag_drop.rs:41`, `cloud_sync.rs:1-3`, `clipboard_ops.rs:369`), commands are
   scattered across five directories, and `setup.rs` calls command functions directly.
2. **Four god modules** hold ~40% of the code: `cloud_sync.rs` (3,603), `clipboard\utils.rs` (2,468),
   `clipboard_repo.rs` (2,022), `setup.rs` (1,339).
3. **Security: the LAN file-transfer server has no authentication and no upload limits**, plus two
   real injection vectors (cmd.exe and PowerShell) and a legacy-cleanup routine that deletes
   directories by name match alone.
4. **A handful of correctness bugs** hide in plain sight (a wrong AtomicBool in
   `settings_cmd.rs:123-127`, unbounded HGLOBAL walks in `win_clipboard.rs:426-458`, moving a live
   SQLite DB in `system_cmd.rs:404-481`).
5. **Comment norms are inconsistent**: mixed Chinese/English, "tombstone" comments for deleted
   functions, a few stale comments, and almost no high-level documentation in the largest files.

Notable strengths worth preserving: DPAPI encryption-at-rest for sensitive entries, parameterized
SQL everywhere (dynamic fragments are compile-time constants only), the FTS5 search architecture,
the pipeline stage abstraction, and the measured, commented performance work.

---

## 2. Coupling Findings

### 2.1 Module import graph (internal `use crate::…` edges, key paths)

| From | To (crate-internal) | Line |
|---|---|---|
| `app\setup.rs` | `app::commands::{set_theme, register_hotkey, system_cmd::*}` — **setup calls commands** | setup.rs:650, 659-660, 1063 |
| `app\hooks\mod.rs` | `app::window_manager::{hide_window_cmd, toggle_window}` | hooks\mod.rs:16 |
| `app\hooks\mod.rs` | `services::clipboard_ops::paste_history_item_by_index` | hooks\mod.rs:304 |
| `infrastructure\windows_api\drag_drop.rs` | `app::commands::file_cmd::image_ext_from_bytes` — **infrastructure → commands** | drag_drop.rs:41 |
| `services\cloud_sync.rs` | `app::commands::file_cmd::{image_ext_from_mime, list_emoji_favorite_paths_in_dir, save_emoji_favorite_bytes_to_dir}` — **service → commands** | cloud_sync.rs:1-3 |
| `services\clipboard_ops.rs` | `app::commands::history_cmd::get_clipboard_history` — **service → commands** | clipboard_ops.rs:369-375, 1375-1381 |
| `services\clipboard\pipeline.rs` | `services::clipboard_ops::clear_recent_paste_marker` — **cycle** (clipboard_ops also imports `services::clipboard::*` at clipboard_ops.rs:7-12) | pipeline.rs:290, 304 |
| `services\file_transfer\*` | `app_state`, `database::ClipboardEntry` (re-exported from `database`) | file_transfer\mod.rs:19-23 |
| `app\commands\*` | services (mqtt, cloud_sync, clipboard, encryption_queue), infrastructure repos, win32 APIs | throughout |
| `database.rs` | `pub use` of `infrastructure::encryption` and `domain::models` — root module acts as re-export hub | database.rs:5-7 |
| `app\setup.rs` | registers 9 `file_transfer` state types — services' internal state managed by setup | setup.rs:403-418 |

### 2.2 Findings table

| File:line | Issue | Severity | Suggested direction |
|---|---|---|---|
| `infrastructure\windows_api\drag_drop.rs:41` | Infrastructure module depends on `app::commands::file_cmd::image_ext_from_bytes` — dependency points the wrong way up the stack | High | Move `image_ext_from_bytes` into a shared module (e.g. `domain`/`infrastructure::utils` or a small `media` module) and import it from both sides |
| `services\cloud_sync.rs:1-3` | Sync service imports emoji/image helpers from a command handler module | High | Same fix — extract to shared utility module |
| `services\clipboard_ops.rs:369-375, 1375-1381` | Service calls `app::commands::history_cmd::get_clipboard_history` directly (both a layering violation and a dependency on UI-truncation behavior) | Medium | Add a `history_service` (repo query + sort, no truncation) and have both the command and clipboard_ops use it |
| `app\setup.rs:650, 659-660, 1063` | Setup calls command functions (`register_hotkey`, `trigger_registry_win_v_optimization`, `set_theme`) | Medium | Extract the underlying logic into services; commands become thin wrappers |
| `services\clipboard\pipeline.rs:290` vs `services\clipboard_ops.rs:7-12` | Mutual module cycle: `clipboard` ↔ `clipboard_ops` | Medium | Move `clear_recent_paste_marker`/`remember_recent_paste` into `PasteQueue` state (paste_queue.rs) or a shared `paste_state` module |
| `services\cloud_sync.rs` (3,603 lines) | God module: WebDAV protocol client + sync engine + settings sync + emoji sync + status + tests in one file | High | Split: `cloud_sync/webdav_client.rs`, `cloud_sync/engine.rs`, `cloud_sync/settings.rs`, `cloud_sync/emoji.rs` |
| `services\clipboard\utils.rs` (2,468 lines) | God module: HTML parsing, Office/WPS noise stripping, CF_HTML parsing, previews, cleanup rules, sensitive detection, image fetching | High | Split: `html.rs`, `cf_html.rs`, `preview.rs`, `cleanup.rs`, `sensitive.rs` |
| `infrastructure\repository\clipboard_repo.rs` (2,022 lines) | God module: history/save/delete/pin/search/FTS/encryption-cache + 500-line test module | Medium | Keep tests (excellent) but split search paths (`search_indexed`, `search_linear`, `search_sensitive_paged`) into `search.rs` |
| `app\setup.rs` (1,339 lines) | God module: data-dir resolution, DB init, 9 state registrations, window creation/repair (~250 lines of geometry), edge-docking monitor thread, tray, hooks, theme, shortcut + window-event dispatch | High | Move window-geometry repair (`WindowRect`, `clamp_window_rect_to_monitor`, etc.) to `window_manager.rs`; move `start_edge_docking_monitor` to a service; setup becomes wiring-only |
| `services\clipboard\mod.rs:495-1037` | `start_clipboard_monitor` callback is a ~540-line closure | High | Extract into a `monitor.rs` with named functions per content class (files / rich text / image / text) |
| `app\window_manager.rs:74-378` | `toggle_window` is 300 lines with three near-identical monitor-selection branches (lines 137-157, 202-219, 280-296) | Medium | Extract `find_monitor_at_point()`; collapse the three branches |
| `infrastructure\repository\clipboard_repo.rs:331-353, 1227-1267, 1054-1096` and `tag_repo.rs:246-279` | Four separate row→`ClipboardEntry` mappers (three in one file) | High | One canonical `row_to_entry` used by all queries; delete the duplicates |
| `database.rs:271-280`, `file_cmd.rs:50-59`, `services\clipboard\utils.rs:63-73` | `image_ext_from_bytes` implemented three times | Medium | Single shared copy |
| `clipboard_repo.rs:27-34`, `services\sensitive_align.rs:23-29` (+ hardcoded copy in tests `clipboard_repo.rs:1567`) | `sensitive_tags_sql()` builder duplicated | Low | Move into `database.rs` next to `SENSITIVE_TAGS` |
| `setup.rs:440-458, 869-884, 930-950`; `window_manager.rs:354-361, 403-407, 447-451`; `settings_cmd.rs:199-215` | Identical `GetWindowLongPtrW/SetWindowLongPtrW` + `WS_EX_NOACTIVATE` toggling in 6 places | Medium | Add `WindowExt::set_no_activate(hwnd, bool)` in `windows_ext.rs` |
| `utils.rs:189-225, 2029-2050, 2113-2134`; `clipboard_repo.rs:630-658`; `clipboard_ops.rs:43-76`; `cloud_sync.rs:527-582` | The `file://`→local-path normalization dance (strip scheme, drive-prefix fixup, URL-decode, strip query/hash) exists in 6 variants | High | One `path_from_file_url_or_raw()` helper; bug fixes then apply everywhere at once |
| `history_cmd.rs:70-102, 138-170, 222-248`; `utils.rs:1093-1114` | UI truncation/preview post-processing duplicated 4×, and with **inconsistent limits** (2,000 chars in get/search history, 50,000 in `get_tag_items`, 5,000 for HTML) | High | Single `prepare_entries_for_ui(&mut [ClipboardEntry])`; pick one limit |
| `win_clipboard.rs:801-867` and `997-1052` | DIB header build + RGBA→BGRA flip written twice inside one file | Medium | Extract `build_dib_from_image()` |
| `clipboard_ops.rs:204-225, 301-318`; `content_handler.rs:24-47`; `paste_queue.rs:96-112`; `ai_cmd.rs:178-193` | "Resolve full content by id (DB or session)" pattern duplicated 4× | Medium | `entry_resolver::resolve(id) -> Option<(content, type, html)>` |
| `services\clipboard\mod.rs:655-664, 738-747, 793-809` | GIF-format probing loop duplicated 3× inside the monitor | Low | One `read_gif_format()` helper |
| `pipeline.rs:530-534`; `file_transfer\mod.rs:465-469`; `file_transfer\handlers.rs:258-262` | Negative session-id generation (`-(micros/1000)`) duplicated; **same-millisecond captures collide** | Medium | Single `session_id::next()` (monotonic counter or retry on collision) |
| `main.rs:142-257` | 110 commands registered inline; `lib.rs` is the untouched Tauri template whose `greet` command is dead code | Low | Delete `greet`; group command registration by feature; keep lib.rs as the module root or delete it |
| `app\commands\settings_cmd.rs:19-430` | ~30 near-identical setter commands (state store + repo.set boilerplate) | Medium | Typed setting registry: one `set_setting(key, value)` command + a `SettingsRegistry` table mapping key→(parse, apply) |
| `app\commands\system_cmd.rs:404-481` | `set_data_path` embeds a full data-migration engine (folder copies, DB rewrites) inside a command | High | Move to `services\data_migration.rs`; command becomes a thin trigger |
| `app\commands\ai_cmd.rs:64-124, 170-490` | AI profile resolution, prompt building, response post-processing all live in the command | Medium | Extract `services\ai.rs` |
| `database.rs:5-7` | Root `database` module re-exports `encryption` and `domain::models`; callers import `crate::database::ClipboardEntry` instead of `crate::domain::models::ClipboardEntry` | Low | Remove re-exports; import from real homes |
| `services\file_transfer\mod.rs:29-517`, `handlers.rs`, `services\paste_queue.rs`, `services\clipboard_ops.rs`, `infrastructure\windows_api\apps.rs:35-252`, `app\hooks\mod.rs:74`, `app\window_manager.rs` | `#[tauri::command]` functions live in 6 different directories | Medium | Decide one convention (suggest: all commands under `app\commands`, delegating to services) |

---

## 3. Comment-Norm Findings

### 3.1 Language consistency

The codebase mixes Chinese and English comments freely. Rough distribution:

| File | Chinese comments | English comments | Verdict |
|---|---|---|---|
| `infrastructure\windows_ext.rs:16-177` | Mostly (good quality) | Some | Mixed — but the Chinese block at 168-172 is an excellent explanation |
| `migration.rs` | `println!` output strings Chinese; doc comments English | Mostly | Mixed |
| `main.rs:98` | 1 Chinese comment | Otherwise English, high quality | Mixed (single outlier) |
| `app\setup.rs:459` | 1 Chinese comment | Otherwise English | Mixed (single outlier) |
| `database.rs:648-753` | Chinese in tests | English in production code | Split by section |
| `error.rs:19-29` | Chinese user-facing strings in `Display`; Chinese comment | English types | Mixed |
| `cloud_sync.rs:1843` | Chinese comment (坚果云 compatibility) | English elsewhere | Mixed (single outlier) |
| `mqtt_sub.rs:57` | Chinese comment | English elsewhere | Mixed |
| `file_transfer\utils.rs:54`, `handlers.rs:204, 313` | Chinese | English | Mixed |
| `ai_cmd.rs:64-123` | Chinese **string literals** (prompts — fine), one Chinese comment | English | OK |
| `infrastructure\repository\*`, `services\clipboard\*` | None | English only, high quality | Consistent |

**Norm:** pick English as the code language (code already ~90% English identifiers); keep user-facing strings as-is but route them through an i18n module. Comments in either language are acceptable individually, but files mixing both with no reason (`setup.rs:459`, `cloud_sync.rs:1843`) should be normalized.

### 3.2 Findings table

| File:line | Issue | Severity | Direction |
|---|---|---|---|
| `database.rs:250, 316-322, 633-636` | "// save_entry removed (migrated to repository)" style tombstone comments for deleted functions — dead commentary that will rot | Medium | Delete them; git history records the migration |
| `cloud_sync.rs` (whole file) | 3,603 lines with **zero module-level documentation**; the sync protocol (op batches, `head.json`, per-device cursors, tombstones, blob sharding) is only discoverable by reading the code | High | Add a `//!` module doc describing the protocol and the invariants (`head.json` staleness, cursor map, snapshot cadence) |
| `services\sensitive_align.rs:8-120` | No doc explaining what this one-time background job is or why it exists | Medium | One paragraph: aligns DPAPI encryption state with current tags, runs once, guarded by `db.sensitive_alignment_done` |
| `app\hooks\mod.rs:236, 258, 325` | Comment numbering "3. Global Paste Sound", "4. Quick Paste", "5. Global Navigation" — sections 1 and 2 no longer exist in the file | Low | Renumber or drop the numbering |
| `tag_repo.rs:278` | `file_preview_exists: true, // simplified` — placeholder hides a real inconsistency (other code computes it with `Path::exists()`, see `clipboard_repo.rs:1253-1261`) | Medium | Compute the real value or document the invariant explicitly |
| `settings_repo.rs:211` | "Note: seed_defaults should probably be called by the caller or we move it here" — undecided design left as a comment | Low | Resolve and remove the note |
| `apps.rs:631` | "// Moved from main.rs" — provenance comment with no reader value | Low | Remove |
| `ai_cmd.rs:58-61` | "We used to have an injection check here, but it's too aggressive…" — historical rationale in code | Low | Move to git/PR notes; keep only "truncated to 10,000 chars" |
| `paste_queue.rs:76-78` | `if let Some(_) = content_opt { // Logic to prepare next item }` — **dead stub with a misleading comment** (prepare_next_paste_item does nothing) | High | Implement or delete the function; its call site (paste_queue.rs:52) suggests the frontend expects a real side effect |
| `global_state.rs:21` | "Win+ hotkeys are now handled via tauri-plugin-global-shortcut." — only partially true: `hooks\mod.rs:89-123` still `RegisterHotKey`s Win+A–Z/0–9 in recording mode | Medium | Update comment to state both mechanisms |
| `cloud_sync.rs:305-306` | `// TODO: Restore provider switching after a real HTTP sync service is available.` — honest, but `sync_once_http` and the whole `Http` provider path (~70 lines: 2805-2878) is effectively dead code while the provider is hardcoded to `WebDav` (307) | Low | Delete the dead path or gate it behind the TODO with a feature flag |
| `win_clipboard.rs:356` | Commented-out `// println!("❌ Unsupported bit depth…")` | Low | Replace with a real `info!`/debug log or remove |
| `window_tracker.rs:227` | Commented-out debug `println!` | Low | Remove |
| `windows_ext.rs:168-172`, `database.rs:100-119`, `clipboard_repo.rs:355-380, 503-516`, `migrations.rs:201-210` | Exemplary "why" comments with measurements — the house style to keep | — | Use as the standard; the repo is very uneven |
| `services\clipboard\utils.rs` | Zero function docs on the densest regex logic in the app (`strip_office_preview_noise` 591-651, `normalize_clipboard_plain_text` 789-865) — names help but the Office/WPS heuristics need 2-3 line docs each | Medium | Short doc comments with a before/after example per function |
| `content_handler.rs:940-1295` (in `clipboard_ops.rs`), `clipboard_ops.rs:940-1295` | `send_paste_keystroke` magic timing constants (50/80/120/250 ms, per-char delays) with almost no explanation | Medium | Document the timing rationale (target-app tolerance, observed failures) in one comment block |
| `Cargo.toml:74-85` | Release-profile comments in Chinese while the rest of the file is English | Low | Normalize |

**Overall comment verdict:** better than typical (many genuinely useful rationale comments, no misleading "explain what the line says" spam), but the largest and most complex files are the least documented, and the mixed-language drift plus tombstones should be cleaned up.

---

## 4. Security Findings

| File:line | Issue | Severity | Concrete fix |
|---|---|---|---|
| `services\file_transfer\handlers.rs` (all endpoints), `file_transfer\mod.rs:301-315` | **No authentication on any HTTP endpoint.** The axum server binds `0.0.0.0` (utils.rs:92-110) and exposes `/upload`, `/upload-chunk`, `/send_text`, `/ws`, `/poll`, `/download/{token}` to the whole LAN. Any LAN client can push text/files into the clipboard history, and trigger writes to the system clipboard when `file_transfer_auto_copy` is on (mod.rs:483-489) | High | Add a pairing token (QR-scanned, like the existing chat flow) required as header/query on every route; reject requests without it |
| `services\file_transfer\handlers.rs:71` | Download token for images is **predictable**: `format!("temp_{}", m.id)` with sequential message ids — anyone on the LAN can iterate `temp_1..temp_n` and download every image ever shared | High | Use `Uuid` for all tokens (as `send_file_to_client` already does at mod.rs:99) |
| `services\file_transfer\handlers.rs:352-356` and `469-474` | Upload filename from multipart is joined into `save_dir` **without sanitization** — `..\..\` escapes the download dir; on Windows an absolute path replaces the prefix entirely, allowing arbitrary file write (e.g. `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\evil.exe`) | High | Take `Path::file_name()` only, reject names containing `\`, `/`, `:` or starting with `.`; verify the final canonical path starts with `save_dir` |
| `services\file_transfer\handlers.rs:433-451` | Same traversal via `upload_id` in `path.join(format!(".tmp_{}", meta.upload_id))` | High | Treat upload_id as opaque: hash it (`Sha256(id)[..16] hex`) before joining |
| `services\file_transfer\mod.rs:315` | `DefaultBodyLimit::disable()` — uploads are unbounded (disk fill by LAN attacker); `upload_chunk` additionally buffers a whole chunk via `field.bytes()` (handlers.rs:412) — memory DoS | High | Re-enable a sane limit (e.g. 64 MB) and enforce `total_size`/per-chunk caps in `ChunkMetadata` |
| `services\content_handler.rs:179-183` | `cmd /C start "" <content>` where `content` is **clipboard content**: cmd metacharacters (`&`, `|`, `^`, `%VAR%`) are interpreted → arbitrary command execution from crafted clipboard content | High | Use `ShellExecuteW` (already available at lines 336-358) for URLs, or pass the URL as a proper quoted argv |
| `services\content_handler.rs:142-146, 294-297` | PowerShell string built with `app` (user setting / UWP AppID) **unescaped** inside `'shell:AppsFolder\{app}'`; only `content` gets `''`-escaped | Medium | Validate `app` against `^[A-Za-z0-9._! -]+$` (AppID charset) before interpolation; prefer WinRT `Launcher` API (already used at apps.rs:632-683) |
| `infrastructure\windows_api\apps.rs:185-228` | User-supplied `extension` interpolated raw into a PowerShell script (`$ext = "{}"`) — quote/`;` injection | Medium | Validate `extension` against `^\.[A-Za-z0-9]+$` before formatting |
| `infrastructure\windows_api\apps.rs:643-663` | `family_name` interpolated into PS script without escaping (file_path is escaped at 661) | Low | Escape or validate the family-name segment |
| `infrastructure\windows_api\win_clipboard.rs:426-440, 444-458` | `get_clipboard_files` walks the CF_HDROP buffer to the double-NUL **without any bounds check against `GlobalSize`**; a malformed or malicious clipboard payload (another process owns the data) causes out-of-bounds reads → crash/UB | High | Compute `size = GlobalSize(h_global)`; loop while `ptr < end`; validate `p_files_val <= size` |
| `migration.rs:247-302` | `cleanup_old_install_folder` deletes any directory named `贴汁` under ProgramFiles/LOCALAPPDATA based on **name match alone** (only guard: not the current exe dir; `PathBuf` equality is case-sensitive at line 279) — it can delete unrelated user folders; combined with registry cleanup (109-174) which deletes uninstall entries for anything whose DisplayName contains `贴汁` | High | Only delete paths proven to be the old install (registry `InstallLocation` with the old app exe inside); drop the name-based guessing entirely; never `remove_dir_all` without user confirmation |
| `services\mqtt_sub.rs:479-519` | Any MQTT publisher on the subscribed topic can write to the user's system clipboard and inject history entries; connection is anonymous when `mqtt_username` is empty (387-390) | High | Require credentials when connecting (fail if missing); consider gating remote clipboard writes behind a user setting; document trust model |
| `services\mqtt_sub.rs:311-371` | `tls_insecure` flag installs a `NoVerifier` accepting any certificate — MITM of all synced clipboard data | Medium | Remove the option or warn loudly; never default it on |
| `services\file_transfer\handlers.rs` + `mod.rs` | No `Origin` check on the WebSocket/HTTP endpoints: a malicious webpage opened by the user can `fetch()`/`ws://` to `192.168.x.x:<port>` (browser-to-LAN CSRF) and use the endpoints | Medium | Validate `Origin`/`Host` on WS upgrade and reject cross-origin POSTs (CORS policy) |
| `services\clipboard\utils.rs:96-143, 2078-2085, 2170-2177` | Rich-HTML capture fetches remote images referenced by clipboard HTML (`fetch_remote_image`) — SSRF-ish (can hit localhost/intranet hosts when copying from a crafted page); capped at 8 MB/4 s, but the fetch itself leaks presence | Low-Medium | Restrict to public IP ranges (reject RFC1918/link-local), or make it opt-in |
| `infrastructure\windows_api\drag_drop.rs:214-233, 263-304` | Drag-drop file contents are read into memory with no size cap (`read_stream`, `read_virtual_files`) | Medium | Cap at e.g. 50 MB per file; skip larger files |
| `infrastructure\encryption.rs:65-123` | DPAPI FFI blocks have no `# Safety` comments; plaintext copies (`out.to_vec()`) are not zeroized after decrypt | Low | Add `# Safety` docs; use `zeroize` on the decrypted buffers where feasible |
| `app\system.rs:11-36` | Device id is 8 hex chars (32-bit) of SHA-256 — high collision probability for the sync/MQTT routing identity (used in `cloud_sync.rs:349-366` to address per-device state) | Low-Medium | Use the full hash or 12+ chars; the `build_anon_id`/`is_legacy_placeholder_anon_id` plumbing already anticipates a format change |
| `settings_repo.rs:29-121` | Sensitive values (`mqtt_password`, `ai_profiles`, `cloud_sync_webdav_password`, `cloud_sync_api_key`) are DPAPI-encrypted at rest — **good**; but `get_all()` (settings_repo.rs:171-206) decrypts and sends them to the frontend, and `get_settings` command exposes them | Low | Verify the frontend truly needs them; consider masking on read |
| SQL across repos | All user input is bound via `params!`; dynamic SQL fragments (`sensitive_tags_sql`, `{cols}`, `{placeholders}` in clipboard_repo.rs:380-435, 468-485, 1607-1647) come from compile-time constants only | Info (no fix) | Keep it this way; add a comment at `ENTRY_COLUMNS` already exists — good |
| `app\commands\file_cmd.rs:27-30` | `save_file_copy(source, target)` copies arbitrary paths supplied by the frontend without validation | Low | Acceptable for the app's own UI, but restrict target to data dir if the command is ever called with remote-sourced input |

---

## 5. Performance Findings

| File:line | Issue | Severity | Concrete fix |
|---|---|---|---|
| `app\commands\history_cmd.rs:197-213` → `clipboard_repo.rs:1412` | `clear_clipboard_history` is a **synchronous** command on the main thread and ends with `VACUUM` on a possibly multi-hundred-MB DB → multi-second UI freeze | High | Mark the command `#[tauri::command(async)]` (see history_cmd.rs:107-109 for the pattern) and/or move VACUUM to a background thread |
| `app\commands\system_cmd.rs:404-481` | `set_data_path` copies folders, moves DB files, and runs row-by-row UPDATEs (499-553) — all on the main thread | High | Run on `spawn_blocking`; show progress events |
| `app\hooks\mod.rs:265, 42-54` | `quick_paste_modifier_from_settings()` locks a global `Mutex` **on every key press** (called from `keyboard_proc` for all digit keys, system-wide) — measurable input latency | High | Cache the modifier string in an `AtomicU8`/static updated by the settings command |
| `app\hooks\mod.rs:249-251` | `std::thread::spawn` per Ctrl+V keydown (system-wide hook) | Medium | Debounce or use a channel/flag; the emit itself is cheap, the spawn isn't free per keystroke |
| `app\setup.rs:667-957` | Edge-docking monitor polls every 150 ms forever (Win32 `GetWindowRect`/`GetCursorPos` per tick), even when edge-docking is disabled | Medium | When disabled, sleep longer (1 s) or park on a condvar; only poll at 150 ms while docked/active |
| `services\cloud_sync.rs:1053-1112` | Every sync cycle (default 120 s) pages through the **entire** history (`get_history` 1,000 rows/page) materializing full rows incl. `html_content`, per-row DPAPI decrypt and per-external-row `Path::exists()` stat (clipboard_repo.rs:1253-1261) | High | Use a dedicated "sync candidates" query that selects only `id, content_type, content, html_content, timestamp, …` with a cursor, no `file_preview_exists`; rely on `cloud_sync_local_index` digests for delta (already computed at 978-999) |
| `services\cloud_sync.rs:1752-1766, 2476-2496` | Sequential awaits for blob uploads and per-seq op downloads — no concurrency | Medium | `buffer_unordered(4)` for blob uploads; batch op fetches |
| `services\cloud_sync.rs:1698-1750, 825-835` | `webdav_blob_cache` (up to 5,000 entries) is re-serialized and written to the settings table after **every** blob upload | Medium | Persist at end of cycle only; or keep in-memory + write dirty flag |
| `services\clipboard\pipeline.rs:423-448` | Session dedup re-computes `calc_image_hash` (full image decode) for **every stored session image on every image capture** (up to 500 items) | High | Cache the hash per session entry (add a field to ClipboardEntry or a side map), invalidate on update |
| `services\clipboard_ops.rs:766-799` | `copy_image_bytes_to_clipboard` decodes the image **twice** (`load_from_memory` at 766 and 793) | Medium | Decode once; encode PNG from the first `DynamicImage` |
| `infrastructure\windows_api\apps.rs:130-150, 230-240, 665-675` | Spawns a PowerShell process per app scan / association query / UWP launch; `Command::output()` blocks inside `async fn` | Medium | Use `spawn_blocking`/`tokio::process`; cache scans |
| `services\content_handler.rs:372-406` | Every opened file spawns a thread that polls every 2 s for up to 1 hour | Low | Use a single shared watcher thread with a work queue; or `notify` crate |
| `services\mqtt_sub.rs:445-547, 64-218` | When idle, the event loop times out every 5 s and `get_mqtt_config` re-runs ~15 SQLite queries + DPAPI decrypts | Medium | Cache config; invalidate on settings-change |
| `infrastructure\repository\clipboard_repo.rs:908-925` | Image dedup fallback reads and re-hashes up to the last 200 images on every image capture | Medium | Keep an in-memory `HashMap<hash, id>` index instead of re-scanning |
| `infrastructure\repository\clipboard_repo.rs:960-1013, 1390-1414` | Limit enforcement and `clear()` delete row-by-row (each a SELECT + file I/O + tombstone write) | Medium | Set-based: `SELECT id … LIMIT n` then one `DELETE WHERE id IN (…)` + batched tombstones |
| `infrastructure\repository\clipboard_repo.rs:1039-1052` | `update_pinned_order` issues one UPDATE per pinned item (transaction-wrapped, so acceptable) | Low | Single multi-row UPDATE via CASE when pinned sets are large |
| `logger.rs:15-27` | Opens + appends the log file on **every** log line; `println!` on every call | Medium | Keep an open `File` behind the mutex; gate console output on debug builds |
| `app\window_manager.rs:465-476` | `restore_last_focus` (a `#[tauri::command]`) does `thread::sleep(60 ms)` — blocks the main thread when invoked from command/focus paths | Medium | Move the sleep to a background thread or make the command async |
| `services\paste_queue.rs:166` | `thread::sleep(20 ms)` inside `async fn` blocks the async worker | Low | `tokio::time::sleep` |
| `services\sensitive_align.rs:35-115` | One-time startup scan reads the entire `content`+`html_content` columns of the whole table (batched, with 50 ms sleeps) | Low | Acceptable as a one-time job; add a doc comment with the expected cost |
| `app\setup.rs:209-342` | `load_settings` performs ~35 individual `settings_repo.get` calls (each a SQLite query + mutex) at startup | Low | One `SELECT key, value FROM settings` and parse in memory |
| `services\file_transfer\models.rs:55` (`ChatState`) | Chat history `Vec<Message>` grows unbounded for the session | Low | Cap at N entries (as SessionHistory does at 500) |
| `infrastructure\windows_api\apps.rs:32-33` | `EXECUTABLE_ICON_CACHE`/`FILE_ICON_CACHE` are unbounded `HashMap`s | Low | LRU cap (e.g. 512 entries) |
| `services\file_transfer\mod.rs:99-102, 194-198, 363-366` | `SharedFileState` tokens are never expired/removed — memory growth and permanent download capability | Medium | Store `(path, created_at)`, prune older than e.g. 1 h |

---

## 6. Top 10 Recommended Fixes (ordered by impact ÷ effort)

1. **Secure the LAN file server.** Add a pairing token checked on every route, replace the predictable `temp_{id}` download tokens with UUIDs, sanitize multipart filenames and `upload_id` (basename + canonical-path check), and re-enable a body-size limit. *Files: `file_transfer\handlers.rs:71, 352-356, 412, 433-451, 469-474`; `file_transfer\mod.rs:315`. High impact (prevents LAN RCE-adjacent file write + data exfil), moderate effort.*
2. **Fix command-injection vectors.** Replace `cmd /C start` with `ShellExecuteW` for URLs (`content_handler.rs:179-183`), and validate/escape `app` and `extension` before PowerShell interpolation (`content_handler.rs:142-146, 294-297`; `apps.rs:185-228, 643-663`). High impact, low effort.
3. **Bound the CF_HDROP parse.** Use `GlobalSize` to cap the pointer walk in `get_clipboard_files` (`win_clipboard.rs:426-458`). Prevents crashes from malformed clipboard payloads. High impact (availability), low effort.
4. **Stop name-based folder deletion in `migration.rs`.** Only delete paths proven to come from the old install (registry `InstallLocation` + old exe present); drop `cleanup_old_install_folder`'s guess list (`migration.rs:247-302`). High impact, low effort.
5. **Fix `save_setting("app.sound_paste_enabled")`** writing the wrong `AtomicBool` (`delete_after_paste` instead of a paste-sound flag) at `settings_cmd.rs:123-127`. Trivial one-line class fix.
6. **Make `set_data_path` safe.** `PRAGMA wal_checkpoint` + close the live connection before moving DB files, rewrite paths, then force an app restart; move the whole routine off the main thread (`system_cmd.rs:404-481`). Prevents silent data loss. High impact, moderate effort.
7. **Harden MQTT ingest.** Require credentials (no anonymous connect), drop the `tls_insecure` NoVerifier path or gate it behind an explicit developer flag, and stop spawning a thread per message (`mqtt_sub.rs:311-390, 479-519`). High impact, low effort.
8. **Get heavy DB work off the main thread.** Mark `clear_clipboard_history` (VACUUM), `delete_clipboard_entry`, `delete_tag_from_all`, and `set_data_path` as `#[tauri::command(async)]` (pattern documented at `history_cmd.rs:107-109`). Medium impact, low effort.
9. **De-duplicate the six copies of file-path normalization and the four row→entry mappers.** One `path_from_file_url_or_raw()` and one `row_to_entry` fix divergent behavior in a single place (paths listed in §2.2). Medium impact, moderate effort.
10. **Kill the two biggest hot-path costs.** Cache `quick_paste_modifier` in an atomic instead of a per-keystroke mutex (`hooks\mod.rs:42-54, 265`), and cache image hashes for session entries so captures don't re-decode up to 500 images (`pipeline.rs:423-448`). Medium impact, low effort.

Longer-term structural work (after the above): split `cloud_sync.rs` / `clipboard\utils.rs` / `clipboard_repo.rs` / `setup.rs`; extract `services\ai.rs`, `services\data_migration.rs`; consolidate commands under `app\commands`; add the missing module docs for the sync protocol; normalize comment language to English.

---

## Appendix A — God-module line counts (actual)

| File | Lines | Responsibilities |
|---|---|---|
| `services\cloud_sync.rs` | 3,603 | WebDAV client, sync engine, settings sync, emoji sync, status, tests |
| `services\clipboard\utils.rs` | 2,468 | HTML/CF_HTML parsing, Office noise, previews, cleanup rules, sensitive detection, image fetch, tests |
| `infrastructure\repository\clipboard_repo.rs` | 2,022 | CRUD, pin, search (3 paths), FTS, encryption cache, tests |
| `services\clipboard_ops.rs` | 1,401 | Clipboard payload assembly, paste simulation, focus management |
| `app\setup.rs` | 1,339 | Startup wiring + window geometry + docking monitor + event dispatch |
| `services\clipboard\mod.rs` | 1,114 | Clipboard monitor (540-line closure) + format probing |
| `infrastructure\windows_api\win_clipboard.rs` | 1,059 | Raw Win32 clipboard read/write |
| `services\file_transfer\web_ui.rs` | 1,097 | ~1,000 lines of embedded HTML/CSS/JS as a Rust string — move to an asset file |

## Appendix B — `unsafe` distribution

~147 `unsafe` sites, essentially all in the Win32 interop layer (`win_clipboard.rs`, `drag_drop.rs`, `windows_ext.rs`, `app\hooks\mod.rs`, `app\setup.rs`, `apps.rs`, `encryption.rs`, `window_tracker.rs`, `clipboard_listener.rs`). This is expected for a clipboard manager, but: **no unsafe block in the codebase carries a `# Safety` comment** (the `rust-skills` `doc-safety-section` rule), and the two genuinely dangerous patterns are the unbounded HGLOBAL walk (`win_clipboard.rs:426-458`) and the unbounded drag-drop stream reads (`drag_drop.rs:214-233`). GDI/clipboard handle cleanup is otherwise handled carefully (e.g. `apps.rs:625-628`, `win_clipboard.rs:119, 146`).
