//! JustAsk desktop app. The native layer (accessibility scan, overlay, actions) lives in
//! `native/` behind a fixed command surface; see apps/desktop/src/native.ts for the TS side.
mod native;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(native::handlers())
        .run(tauri::generate_context!())
        .expect("error while running JustAsk");
}
