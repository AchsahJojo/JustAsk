//! Fixed command surface (frozen after Wave 0, docs/refined-plan-2.md). The native-windows agent
//! implements these with UI Automation; macOS with AX. Shapes match @justask/shared
//! (`FrameScan`, `ActSpec`, `ActResult`) as JSON. Field values are never returned.
use serde_json::Value;

/// Scan the foreground window into a `FrameScan` (surface "native"). Stub: empty scan.
#[tauri::command]
pub fn scan_foreground() -> Result<Value, String> {
    Err("native scan not implemented yet".into())
}

/// Draw the overlay ring around element `local_id` from the last scan.
#[tauri::command]
pub fn highlight(local_id: u32, label: String) -> bool {
    let _ = (local_id, label);
    false
}

/// Perform one action through accessibility patterns. Must refuse secure fields.
#[tauri::command]
pub fn act(spec: Value) -> Value {
    let _ = spec;
    serde_json::json!({ "ok": false })
}

#[tauri::command]
pub fn clear() {}

#[tauri::command]
pub fn pulse() {}

/// True once the foreground window changed and settled; false after `timeout_ms`.
#[tauri::command]
pub fn wait_for_change(timeout_ms: u64) -> bool {
    let _ = timeout_ms;
    false
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![scan_foreground, highlight, act, clear, pulse, wait_for_change]
}
