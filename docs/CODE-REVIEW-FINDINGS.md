# Code Review Findings & Optimization Plan

> Consolidated record of the 2026-10-17 full-codebase review (requirement ②),
> plus the optimization backlog with implementation status (requirement ③).
> Detailed per-layer reports: `docs/review/REVIEW-rust.md`, `docs/review/REVIEW-frontend.md`.

## Scope & method

- Rust backend: `src-tauri/src`, 46 files, ~24,000 LOC — every file read in full.
- Frontend: `src/`, ~120 files (TS/TSX/CSS), ~16,000 LOC — every file read in full.
- Cross-cutting greps: `unsafe`, SQL building, process spawning, TODO/FIXME, comment language.
- All findings cite verified `file:line` references in the per-layer reports.

## Key structural facts (coupling)

| Fact | Detail |
|---|---|
| God modules | `cloud_sync.rs` 3,603 · `clipboard/utils.rs` 2,468 · `clipboard_repo.rs` 2,022 · `setup.rs` 1,339 |
| Inverted layering | infrastructure/services import from `app::commands` (`drag_drop.rs:41`, `cloud_sync.rs:1-3`, `clipboard_ops.rs:369`); `setup.rs` calls command fns directly |
| Module cycle | `services::clipboard::pipeline` ↔ `services::clipboard_ops` (`pipeline.rs:290`, `clipboard_ops.rs:7-12`) |
| Duplication | row→entry mapping ×4 · `file://` path normalization ×6 · UI truncation ×4 (limits 2,000 vs 50,000 vs 5,000) · `image_ext_from_bytes` ×3 · `WS_EX_NOACTIVATE` toggle ×6 · session-id `-(micros/1000)` ×3 (same-millisecond collision) |
| Frontend | `ClipboardItem.tsx` 1,686 lines (god component, embeds compact-preview webview lifecycle); ~350 lines rich-text preview logic duplicated ClipboardItem↔CompactPreviewWindow; sanitizer duplicated HtmlContent↔richTextSnapshot; `useAppState` ~145 useState fields; settings row markup copy-pasted ~60×; `TagManager.tsx` embeds ~1,230 lines inline CSS |
| Frontend perf | per-keystroke `save_setting`+MQTT restart; incomplete `memo(ClipboardItem)` comparator (omits `isSensitiveHidden`/`windowPinned`/`tagColors`/`isInputting`); snapshot cache 240×2MB ≈ 480MB worst case |

## Security findings (highest severity first)

1. **LAN file-transfer server: no auth** on any endpoint, binds `0.0.0.0` (`file_transfer/mod.rs:315`); predictable download tokens `temp_{id}` (`handlers.rs:71`); unsanitized multipart filenames joined into `save_dir` → path traversal / arbitrary file write (`handlers.rs:352-356, 433-451, 469-474`); `DefaultBodyLimit::disable()` (unbounded upload DoS).
2. **Command injection from clipboard content**: `cmd /C start "" <content>` (`content_handler.rs:179-183`); PowerShell injection via unescaped `app`/`extension` interpolation (`content_handler.rs:142-146`, `apps.rs:185-228, 643-663`).
3. **Unbounded HGLOBAL walk** in CF_HDROP parse → OOB read from malformed clipboard payload (`win_clipboard.rs:426-458`).
4. **Name-based folder deletion** in legacy cleanup: any folder named `贴汁` under ProgramFiles/LOCALAPPDATA is deleted on startup (`migration.rs:247-302`).
5. **Unauthenticated MQTT can write to the user's clipboard**; `tls_insecure` NoVerifier option (`mqtt_sub.rs:311-390, 479-519`).
6. Frontend XSS surface: hand-rolled sanitizer keeps `iframe/object/embed` + non-Office `<style>`, `javascript:` check bypassable (`HtmlContent.tsx:85-100,132-168`; `richTextSnapshot.ts:78-98,139-176`).
7. `convertFileSrc` accepts arbitrary clipboard-controlled paths (`localImageSrc.ts:18-41`).

## Correctness / data-loss bugs found

- `save_setting("app.sound_paste_enabled")` writes the **wrong AtomicBool** (`delete_after_paste`) — `settings_cmd.rs:123-127`.
- `set_data_path` moves the live SQLite DB (with WAL) while the connection is open, on the main thread (`system_cmd.rs:404-481`).
- `paste_queue.rs:76-78`: dead stub `prepare_next_paste_item` with a misleading comment.
- Frontend: `FileTransferChatView.tsx:730` `decodeURIComponent` can crash render on malformed peer text; `LabelWithHint` defined inside `SettingsPanel` render → settings groups remount every render.

## Comment-norm findings

- Mixed Chinese/English without convention (`setup.rs:459`, `cloud_sync.rs:1843`, `mqtt_sub.rs:57`, `migration.rs`, `Cargo.toml:74-85`).
- Tombstone comments for deleted functions (`database.rs:250, 316-322, 633-636`).
- 3,603-line `cloud_sync.rs` has zero module-level protocol documentation.
- Zero `# Safety` comments across ~147 `unsafe` sites (mostly benign Win32 FFI; two genuinely dangerous: unbounded HGLOBAL walk, unbounded drag-drop reads).
- Exemplary "why" comments to keep as house style: `windows_ext.rs:168-172`, `clipboard_repo.rs:355-380`, `migrations.rs:201-210`.

## Optimization backlog (implementation status)

Batch 1 — Security & correctness (planned first):
- [ ] Sanitize file-transfer filenames/upload_id; UUID download tokens; body-size limit; origin check
- [ ] Replace `cmd /C start` with `ShellExecuteW` for URLs
- [ ] Bound CF_HDROP parse with `GlobalSize`
- [ ] Stop name-based folder deletion in `migration.rs`
- [ ] Fix `sound_paste_enabled` → wrong AtomicBool
- [ ] Require MQTT credentials / gate clipboard writes

Batch 2 — Architecture & code de-dup:
- [ ] Extract `image_ext_from_bytes` to a shared module (fixes 2 layering inversions + 3 duplicates)
- [ ] Single `path_from_file_url_or_raw()` helper (6 variants)
- [ ] Monotonic session-id helper (fixes same-millisecond collision)
- [ ] One canonical `row_to_entry` (4 duplicates)

Batch 3 — Main-thread & hot-path performance:
- [ ] `clear_clipboard_history` VACUUM off the main thread
- [ ] Cache `quick_paste_modifier` in an atomic (per-keystroke mutex today)
- [ ] Cache image hashes for session dedup (up to 500 re-decodes per capture)
- [ ] Frontend: fix `memo(ClipboardItem)` comparator; byte-budget snapshot cache; hoist `LabelWithHint` + memoize settings props; save-on-blur for MQTT/cleanup inputs

Batch 4 — Structural (longer-term, after the above):
- Split god modules (`cloud_sync`, `clipboard/utils`, `clipboard_repo`, `setup`)
- Consolidate `#[tauri::command]`s under `app/commands`; extract `services/ai.rs`, `services/data_migration.rs`
- Add sync-protocol module docs; normalize comment language to English; `# Safety` comments
- DOMPurify allowlist for the shared HTML sanitizer; shared rich-text preview module; settings primitives refactor; i18n sweep; production log hygiene
