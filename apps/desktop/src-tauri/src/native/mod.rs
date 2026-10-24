//! Fixed command surface (frozen after Wave 0, docs/refined-plan-2.md).
//! Windows uses UI Automation; the command and payload shapes match `@justask/shared`.

use serde_json::Value;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
use self::windows as platform;

#[cfg(not(windows))]
mod platform {
    use serde_json::{json, Value};

    pub fn scan_foreground(_app: tauri::AppHandle) -> Result<Value, String> {
        Err("native UI Automation is available on Windows only".into())
    }
    pub fn start_foreground_tracking() {}
    pub fn highlight(_app: tauri::AppHandle, _local_id: u32, _label: String) -> bool {
        false
    }
    pub fn act(_spec: Value) -> Value {
        json!({"ok": false})
    }
    pub fn clear() {}
    pub fn pulse() {}
    pub fn wait_for_change(_timeout_ms: u64) -> bool {
        false
    }
    pub fn open_browser() -> bool {
        false
    }
}

// UI Automation calls run on a blocking worker thread, not the main thread. The main thread
// is a single-threaded COM apartment (WebView2 needs that), UI Automation wants a
// multithreaded one, and long calls there (like wait_for_change) would freeze the window.
// `clear` and `pulse` stay on the main thread because they touch the overlay window, which
// the main thread owns.

/// Start native background work (foreground-window tracking). Call once at startup.
pub fn init() {
    platform::start_foreground_tracking();
}

/// Scan the window she is working in (not JustAsk itself) into a `FrameScan` (surface "native").
#[tauri::command]
pub async fn scan_foreground(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || platform::scan_foreground(app))
        .await
        .map_err(|e| format!("The native scan stopped: {e}"))?
}

/// Draw the overlay ring around element `local_id` from the last scan.
#[tauri::command]
pub async fn highlight(app: tauri::AppHandle, local_id: u32, label: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || platform::highlight(app, local_id, label))
        .await
        .unwrap_or(false)
}

/// Perform one action through accessibility patterns. Must refuse secure fields.
#[tauri::command]
pub async fn act(spec: Value) -> Value {
    tauri::async_runtime::spawn_blocking(move || platform::act(spec))
        .await
        .unwrap_or_else(|_| serde_json::json!({ "ok": false }))
}

#[tauri::command]
pub fn clear() {
    platform::clear()
}

#[tauri::command]
pub fn pulse() {
    platform::pulse()
}

/// True once the target window changed and settled; false after `timeout_ms`.
#[tauri::command]
pub async fn wait_for_change(timeout_ms: u64) -> bool {
    tauri::async_runtime::spawn_blocking(move || platform::wait_for_change(timeout_ms))
        .await
        .unwrap_or(false)
}

/// Open her default browser at its own start page. Takes no arguments on purpose: JustAsk
/// never opens a URL that came from the AI. True when the browser process started.
#[tauri::command]
pub async fn open_browser() -> bool {
    tauri::async_runtime::spawn_blocking(platform::open_browser)
        .await
        .unwrap_or(false)
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        scan_foreground,
        highlight,
        act,
        clear,
        pulse,
        wait_for_change,
        open_browser
    ]
}
