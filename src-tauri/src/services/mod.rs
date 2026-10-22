pub mod clipboard;
pub mod clipboard_listener;
pub mod clipboard_ops;
pub mod cloud_sync;
pub mod content_handler;
pub mod encryption_queue;
pub mod file_transfer;
pub mod mqtt_sub;
pub mod paste_queue;
pub mod sensitive_align;

use std::sync::atomic::{AtomicI64, Ordering};

static LAST_SESSION_ID: AtomicI64 = AtomicI64::new(0);

/// Returns a fresh negative id for session-only (non-persisted) clipboard
/// entries. Negative ids must stay strictly decreasing so they can never
/// collide with database ids; the previous `-(now_micros / 1000)` scheme
/// produced the same id for two captures within the same millisecond.
pub fn next_session_id() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);
    let candidate = -now.max(1);
    loop {
        let last = LAST_SESSION_ID.load(Ordering::Relaxed);
        let next = if candidate >= last {
            last - 1
        } else {
            candidate
        };
        match LAST_SESSION_ID.compare_exchange(last, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(_) => continue,
        }
    }
}
