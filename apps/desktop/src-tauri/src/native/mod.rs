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
    pub fn highlight(_local_id: u32, _label: String) -> bool {
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
}

/// Scan the foreground window into a `FrameScan` (surface "native").
#[tauri::command]
pub fn scan_foreground(app: tauri::AppHandle) -> Result<Value, String> {
    platform::scan_foreground(app)
}

/// Draw the overlay ring around element `local_id` from the last scan.
#[tauri::command]
pub fn highlight(local_id: u32, label: String) -> bool {
    platform::highlight(local_id, label)
}

/// Perform one action through accessibility patterns. Must refuse secure fields.
#[tauri::command]
pub fn act(spec: Value) -> Value {
    platform::act(spec)
}

#[tauri::command]
pub fn clear() {
    platform::clear()
}

#[tauri::command]
pub fn pulse() {
    platform::pulse()
}

/// True once the foreground window changed and settled; false after `timeout_ms`.
#[tauri::command]
pub fn wait_for_change(timeout_ms: u64) -> bool {
    platform::wait_for_change(timeout_ms)
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        scan_foreground,
        highlight,
        act,
        clear,
        pulse,
        wait_for_change
    ]
}
