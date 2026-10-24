//! Windows implementation of the frozen native command surface.
//!
//! UIA element values are never put in the snapshot. For edit controls their UIA
//! `Name` is deliberately ignored too, since some providers incorrectly expose the
//! current value there. `ValuePattern.CurrentValue` is queried only to compute the
//! local `hasValue` boolean, and never for password fields.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Emitter;
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UISelectionItemPattern, UIValuePattern,
};
use uiautomation::types::{ControlType, Handle, ScrollAmount};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};
use windows::core::{w, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreatePen, DeleteObject, GetDC, GetStockObject, Rectangle, ReleaseDC, SelectObject, HGDIOBJ,
    NULL_BRUSH, PS_SOLID,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, GetForegroundWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    GetTopWindow, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GW_HWNDNEXT,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetMessageW, SetLayeredWindowAttributes, SetWindowPos,
    SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, HWND_TOPMOST,
    LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_COLORKEY, MSG, MSLLHOOKSTRUCT, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WH_MOUSE_LL, WM_LBUTTONUP, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

const MAX_ELEMENTS: usize = 150;
const MAX_WALK_NODES: usize = 4_000;
const MAX_DEPTH: usize = 40;
const MAX_TEXT: usize = 80;

#[derive(Default)]
struct LastScan {
    hwnd: isize,
    targets: HashMap<u32, Vec<i32>>,
    signature: u64,
}

static LAST_SCAN: OnceLock<Mutex<LastScan>> = OnceLock::new();
static OVERLAY: OnceLock<Mutex<isize>> = OnceLock::new();
static APP_HANDLE: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
static GUIDE_RECT: OnceLock<Mutex<Option<(i32, i32, i32, i32)>>> = OnceLock::new();
static MOUSE_HOOK: OnceLock<()> = OnceLock::new();
static FOREGROUND_HOOK: OnceLock<()> = OnceLock::new();
/// The last foreground window that belonged to another app (0 = none seen yet).
static LAST_FOREIGN: AtomicIsize = AtomicIsize::new(0);

fn cache() -> &'static Mutex<LastScan> {
    LAST_SCAN.get_or_init(|| Mutex::new(LastScan::default()))
}

fn overlay_handle() -> &'static Mutex<isize> {
    OVERLAY.get_or_init(|| Mutex::new(0))
}

fn app_handle() -> &'static Mutex<Option<tauri::AppHandle>> {
    APP_HANDLE.get_or_init(|| Mutex::new(None))
}

fn guide_rect() -> &'static Mutex<Option<(i32, i32, i32, i32)>> {
    GUIDE_RECT.get_or_init(|| Mutex::new(None))
}

fn emit_native(event: &'static str, payload: Value) {
    if let Ok(handle) = app_handle().lock() {
        if let Some(app) = handle.as_ref() {
            let _ = app.emit(event, payload);
        }
    }
}

unsafe extern "system" fn low_level_mouse_hook(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 && wparam.0 as u32 == WM_LBUTTONUP {
        let point = *(lparam.0 as *const MSLLHOOKSTRUCT);
        if let Ok(mut target) = guide_rect().lock() {
            if let Some((left, top, right, bottom)) = *target {
                if point.pt.x >= left
                    && point.pt.x <= right
                    && point.pt.y >= top
                    && point.pt.y <= bottom
                {
                    *target = None;
                    emit_native("ja:step-done", json!({ "how": "click" }));
                } else {
                    emit_native("ja:wrong", json!({ "what": "click" }));
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn start_mouse_hook() {
    MOUSE_HOOK.get_or_init(|| {
        let _ = thread::Builder::new()
            .name("justask-mouse-hook".into())
            .spawn(|| unsafe {
                let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_hook), None, 0)
                else {
                    return;
                };
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {}
                let _ = UnhookWindowsHookEx(hook);
            });
    });
}

fn is_own_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid != 0 && pid == unsafe { GetCurrentProcessId() }
}

/// A top-level window she could be working in: visible, not minimized, titled,
/// not a tool window, and not one of ours.
fn is_usable_target(hwnd: HWND) -> bool {
    unsafe {
        !hwnd.0.is_null()
            && IsWindow(Some(hwnd)).as_bool()
            && IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
            && GetWindowTextLengthW(hwnd) > 0
            && (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0) == 0
            && !is_own_window(hwnd)
    }
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if !hwnd.0.is_null() && !is_own_window(hwnd) {
        LAST_FOREIGN.store(hwnd.0 as isize, Ordering::Relaxed);
    }
}

/// Remember the last foreground window of another app, so that while she types or talks
/// in JustAsk, JustAsk still helps with the window she came from.
pub fn start_foreground_tracking() {
    FOREGROUND_HOOK.get_or_init(|| {
        let current = unsafe { GetForegroundWindow() };
        if !current.0.is_null() && !is_own_window(current) {
            LAST_FOREIGN.store(current.0 as isize, Ordering::Relaxed);
        }
        let _ = thread::Builder::new()
            .name("justask-foreground-hook".into())
            .spawn(|| unsafe {
                let hook = SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(on_foreground),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                );
                if hook.is_invalid() {
                    return;
                }
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {}
                let _ = UnhookWinEvent(hook);
            });
    });
}

/// Highest usable window in Z-order. Fallback when no other app has been in front yet.
fn topmost_usable_window() -> Option<HWND> {
    unsafe {
        let mut next = GetTopWindow(None).ok();
        let mut steps = 0;
        while let Some(hwnd) = next {
            steps += 1;
            if steps > 1_000 {
                break;
            }
            if is_usable_target(hwnd) {
                return Some(hwnd);
            }
            next = GetWindow(hwnd, GW_HWNDNEXT).ok();
        }
        None
    }
}

/// The window JustAsk helps with: the foreground window, or, while JustAsk itself is in
/// front, the last window of another app she used.
fn target_hwnd() -> Result<HWND, String> {
    let foreground = unsafe { GetForegroundWindow() };
    if !foreground.0.is_null() && !is_own_window(foreground) {
        return Ok(foreground);
    }
    let last = HWND(LAST_FOREIGN.load(Ordering::Relaxed) as *mut _);
    if is_usable_target(last) {
        return Ok(last);
    }
    topmost_usable_window().ok_or_else(|| "There is no other window to look at yet".into())
}

/// A UI Automation client. `UIAutomation::new()` asks COM for a multithreaded apartment; if
/// this thread already joined another one (RPC_E_CHANGED_MODE), COM still works, so connect
/// directly.
fn automation() -> Result<UIAutomation, String> {
    UIAutomation::new()
        .or_else(|_| UIAutomation::new_direct())
        .map_err(|e| format!("Could not start UI Automation: {e}"))
}

fn current_automation() -> Result<(UIAutomation, UIElement, isize), String> {
    let hwnd = target_hwnd()?;
    let automation = automation()?;
    let root = automation
        .element_from_handle(Handle::from(hwnd))
        .map_err(|e| format!("Could not inspect the foreground window: {e}"))?;
    Ok((automation, root, hwnd.0 as isize))
}

fn app_name(process_id: u32) -> String {
    unsafe {
        if process_id == 0 {
            return "Windows application".into();
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return "Windows application".into();
        };
        let mut path = vec![0u16; 512];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(path.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        if result.is_err() || length == 0 {
            return "Windows application".into();
        }
        let image = String::from_utf16_lossy(&path[..length as usize]);
        std::path::Path::new(&image)
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Windows application")
            .to_string()
    }
}

fn clipped(s: String) -> String {
    let mut value = s.trim().chars().take(MAX_TEXT).collect::<String>();
    if value.chars().count() == MAX_TEXT {
        value.push('…');
    }
    value
}

fn role(control: ControlType) -> &'static str {
    match control {
        ControlType::Button => "button",
        ControlType::Hyperlink => "link",
        ControlType::Edit => "textbox",
        ControlType::ComboBox => "combobox",
        ControlType::CheckBox => "checkbox",
        ControlType::RadioButton => "radio",
        ControlType::ListItem | ControlType::DataItem => "option",
        ControlType::MenuItem => "menuitem",
        ControlType::TabItem => "tab",
        ControlType::Slider => "slider",
        ControlType::Text => "text",
        ControlType::Window => "window",
        ControlType::Group => "group",
        ControlType::Document => "document",
        ControlType::Pane => "region",
        _ => "other",
    }
}

fn is_candidate(control: ControlType) -> bool {
    matches!(
        control,
        ControlType::Button
            | ControlType::Hyperlink
            | ControlType::Edit
            | ControlType::ComboBox
            | ControlType::CheckBox
            | ControlType::RadioButton
            | ControlType::ListItem
            | ControlType::DataItem
            | ControlType::MenuItem
            | ControlType::TabItem
            | ControlType::Slider
    )
}

fn field_kind(control: ControlType, is_password: bool) -> Option<&'static str> {
    if is_password {
        return Some("password");
    }
    match control {
        ControlType::Edit => Some("text"),
        ControlType::ComboBox => Some("select"),
        ControlType::CheckBox => Some("checkbox"),
        ControlType::RadioButton => Some("radio"),
        _ => None,
    }
}

fn looks_sensitive(label_or_id: &str) -> bool {
    let value = label_or_id.to_ascii_lowercase().replace(['-', '_'], " ");
    [
        "password",
        "one time code",
        "verification code",
        "security code",
        "otp",
        "card number",
        "credit card",
        "debit card",
        "cvv",
        "cvc",
        "social security",
        "ssn",
        "routing number",
        "bank account",
        "account number",
        "pin",
    ]
    .iter()
    .any(|marker| value.contains(marker))
}

fn is_sensitive(element: &UIElement, label: Option<&str>) -> bool {
    element.is_password().unwrap_or(true)
        || label.map(looks_sensitive).unwrap_or(false)
        || element
            .get_automation_id()
            .ok()
            .map(|id| looks_sensitive(&id))
            .unwrap_or(false)
}

fn label_for(element: &UIElement) -> Option<String> {
    element
        .get_labeled_by()
        .ok()
        .and_then(|label| label.get_name().ok())
        .map(clipped)
        .filter(|s| !s.is_empty())
}

fn select_options(walker: &UITreeWalker, combo: &UIElement) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending = walker.get_children(combo).unwrap_or_default();
    let mut visited = 0;
    while let Some(child) = pending.pop() {
        visited += 1;
        if visited > 300 || out.len() >= 30 {
            break;
        }
        if matches!(
            child.get_control_type(),
            Ok(ControlType::ListItem | ControlType::DataItem)
        ) {
            if let Ok(name) = child.get_name() {
                let name = clipped(name);
                if !name.is_empty() && !out.contains(&name) {
                    out.push(name);
                }
            }
        }
        pending.extend(walker.get_children(&child).unwrap_or_default());
    }
    out
}

fn element_json(element: &UIElement, walker: &UITreeWalker, number: u32) -> Option<Value> {
    let control = element.get_control_type().ok()?;
    if !is_candidate(control) {
        return None;
    }
    let is_password = element
        .is_password()
        .unwrap_or(matches!(control, ControlType::Edit));
    let field_type = field_kind(control, is_password);
    let label = if field_type.is_some() {
        label_for(element)
    } else {
        None
    };
    let sensitive = field_type.is_some() && is_sensitive(element, label.as_deref());

    // Never send an Edit's UIA Name: providers may expose its current value there.
    let text = if matches!(control, ControlType::Edit | ControlType::ComboBox) {
        String::new()
    } else {
        element.get_name().ok().map(clipped).unwrap_or_default()
    };
    if text.is_empty() && label.is_none() && field_type.is_none() {
        return None;
    }

    let bounds = element.get_bounding_rectangle().ok();
    let in_viewport = !element.is_offscreen().unwrap_or(true)
        && bounds
            .map(|r| r.get_right() > r.get_left() && r.get_bottom() > r.get_top())
            .unwrap_or(false);
    let disabled = !element.is_enabled().unwrap_or(false);
    let nearby: Option<String> = None;

    let field = field_type.map(|kind| {
        // Secure values are never queried, even to compute hasValue.
        let has_value = if sensitive {
            false
        } else {
            element
                .get_pattern::<UIValuePattern>()
                .and_then(|pattern| pattern.get_value())
                .map(|value| !value.is_empty())
                .unwrap_or(false)
        };
        let mut info = json!({
            "kind": kind,
            "hasValue": has_value,
            "valid": true,
            "sensitive": sensitive
        });
        if control == ControlType::ComboBox {
            let options = select_options(walker, element);
            if !options.is_empty() {
                info["optionCount"] = json!(options.len());
                info["options"] = json!(options);
            }
        }
        info
    });

    let runtime_id = element.get_runtime_id().ok()?;
    let mut data = json!({
        "n": number,
        "role": role(control),
        "text": text,
        "label": label,
        "nearby": nearby,
        "color": Value::Null,
        "big": false,
        "disabled": disabled,
        "inModal": false,
        "inViewport": in_viewport,
        "region": "main",
        "_runtimeId": runtime_id
    });
    if let Some(field) = field {
        data["field"] = field;
    }
    Some(data)
}

fn find_runtime_id(
    automation: &UIAutomation,
    root: &UIElement,
    wanted: &[i32],
) -> Option<UIElement> {
    let walker = automation.create_tree_walker().ok()?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut visited = 0usize;
    while let Some((element, depth)) = pending.pop() {
        visited += 1;
        if visited > MAX_WALK_NODES {
            return None;
        }
        if element.get_runtime_id().ok().as_deref() == Some(wanted) {
            return Some(element);
        }
        if depth < MAX_DEPTH {
            pending.extend(
                walker
                    .get_children(&element)
                    .unwrap_or_default()
                    .into_iter()
                    .rev()
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    None
}

pub fn scan_foreground(app: tauri::AppHandle) -> Result<Value, String> {
    if let Ok(mut handle) = app_handle().lock() {
        *handle = Some(app);
    }
    start_mouse_hook();
    let (automation, root, hwnd) = current_automation()?;
    scan_window(&automation, &root, hwnd)
}

/// Dump the foreground window using the same privacy-filtered FrameScan shape as
/// the Tauri command, without initializing the desktop app or its mouse hook.
#[allow(dead_code)] // Also used by the standalone bin, which compiles this module directly.
pub fn dump_snapshot() -> Result<Value, String> {
    let (automation, root, hwnd) = current_automation()?;
    scan_window(&automation, &root, hwnd)
}

fn scan_window(automation: &UIAutomation, root: &UIElement, hwnd: isize) -> Result<Value, String> {
    let title = root.get_name().unwrap_or_default();
    let walker = automation
        .create_tree_walker()
        .map_err(|e| format!("Could not walk UI Automation tree: {e}"))?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut elements = Vec::new();
    let mut targets = HashMap::new();
    let mut visited = 0usize;
    let mut omitted_candidates = 0usize;
    while let Some((element, depth)) = pending.pop() {
        visited += 1;
        if visited > MAX_WALK_NODES {
            break;
        }
        if elements.len() < MAX_ELEMENTS {
            if let Some(mut data) = element_json(&element, &walker, elements.len() as u32 + 1) {
                let n = data["n"].as_u64().unwrap_or(0) as u32;
                let runtime_id: Vec<i32> = serde_json::from_value(data["_runtimeId"].clone())
                    .map_err(|_| "UI Automation returned an invalid element id".to_string())?;
                data.as_object_mut()
                    .expect("element JSON object")
                    .remove("_runtimeId");
                targets.insert(n, runtime_id);
                elements.push(data);
            }
        } else if element
            .get_control_type()
            .map(is_candidate)
            .unwrap_or(false)
        {
            omitted_candidates += 1;
        }
        if depth < MAX_DEPTH {
            if let Some(children) = walker.get_children(&element) {
                pending.extend(children.into_iter().rev().map(|child| (child, depth + 1)));
            }
        }
    }
    let app = json!({
        "name": app_name(root.get_process_id().unwrap_or_default()),
        "window": clipped(title.clone())
    });
    let snapshot = json!({
        "url": "", "title": clipped(title.clone()), "heading": clipped(title), "pageText": "",
        "elements": elements,
        "omitted": { "count": omitted_candidates, "regions": [] },
        "surface": "native", "app": app
    });
    let mut hasher = DefaultHasher::new();
    snapshot.to_string().hash(&mut hasher);
    let signature = hasher.finish();
    if let Ok(mut last) = cache().lock() {
        last.hwnd = hwnd;
        last.targets = targets;
        last.signature = signature;
    }
    Ok(json!({
        "frameId": 0, "isTop": true,
        "snapshot": snapshot,
        "visibleFrames": 0
    }))
}

fn find_scanned_target(local_id: u32) -> Result<UIElement, String> {
    let (automation, root, hwnd) = current_automation()?;
    let wanted = {
        let last = cache()
            .lock()
            .map_err(|_| "Native scan state is unavailable")?;
        if last.hwnd != hwnd {
            return Err("The foreground window changed; scan again before acting".into());
        }
        last.targets
            .get(&local_id)
            .cloned()
            .ok_or_else(|| "The target is no longer in the current scan".to_string())?
    };
    find_runtime_id(&automation, &root, &wanted)
        .ok_or_else(|| "The target disappeared; scan again".into())
}

/// Find the element (UI Automation, on a worker thread), then draw the ring on the main
/// thread. A window belongs to the thread that creates it: only that thread can destroy it
/// (`clear`, also on the main thread), and it dies when that thread exits.
pub fn highlight(app: tauri::AppHandle, local_id: u32, _label: String) -> bool {
    let Ok(element) = find_scanned_target(local_id) else {
        return false;
    };
    // Focus helps her next keystroke land there; the ring doesn't need it, so failure is fine.
    let _ = element.set_focus();
    let Ok(rect) = element.get_bounding_rectangle() else {
        return false;
    };
    let (left, top, right, bottom) = (
        rect.get_left(),
        rect.get_top(),
        rect.get_right(),
        rect.get_bottom(),
    );
    if right <= left || bottom <= top {
        return false;
    }
    let (tx, rx) = mpsc::channel();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(draw_overlay(left, top, right, bottom));
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
}

fn draw_overlay(left: i32, top: i32, right: i32, bottom: i32) -> bool {
    let width = (right - left).max(1);
    let height = (bottom - top).max(1);
    unsafe {
        if let Ok(mut old) = overlay_handle().lock() {
            if *old != 0 {
                let _ = DestroyWindow(windows::Win32::Foundation::HWND(*old as *mut _));
                *old = 0;
            }
            let style = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            let created = CreateWindowExW(
                style,
                w!("STATIC"),
                w!(""),
                // SS_BLACKRECT: black background is color-keyed transparent below.
                windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(WS_POPUP.0 | 0x0004),
                left,
                top,
                width,
                height,
                None,
                None,
                None,
                None,
            );
            let Ok(hwnd) = created else { return false };
            if SetLayeredWindowAttributes(
                hwnd,
                COLORREF(0x0000_0000),
                0,
                LAYERED_WINDOW_ATTRIBUTES_FLAGS(LWA_COLORKEY.0),
            )
            .is_err()
            {
                let _ = DestroyWindow(hwnd);
                return false;
            }
            if SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                left,
                top,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .is_err()
            {
                let _ = DestroyWindow(hwnd);
                return false;
            }
            let hdc = GetDC(Some(hwnd));
            if hdc.0.is_null() {
                let _ = DestroyWindow(hwnd);
                return false;
            }
            // Bright green ring matches the extension's guide highlight.
            let pen = CreatePen(PS_SOLID, 3, COLORREF(0x0060_dca8));
            if pen.0.is_null() {
                let _ = ReleaseDC(Some(hwnd), hdc);
                let _ = DestroyWindow(hwnd);
                return false;
            }
            let previous = SelectObject(hdc, HGDIOBJ(pen.0));
            let previous_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
            let _ = Rectangle(hdc, 1, 1, width.saturating_sub(1), height.saturating_sub(1));
            let _ = SelectObject(hdc, previous_brush);
            let _ = SelectObject(hdc, previous);
            let _ = DeleteObject(HGDIOBJ(pen.0));
            let _ = ReleaseDC(Some(hwnd), hdc);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            *old = hwnd.0 as isize;
            if let Ok(mut target) = guide_rect().lock() {
                *target = Some((left, top, right, bottom));
            }
            true
        } else {
            false
        }
    }
}

pub fn act(spec: Value) -> Value {
    if let Ok(mut target) = guide_rect().lock() {
        *target = None;
    }
    let result = (|| -> Result<(), String> {
        let local_id = spec
            .get("localId")
            .and_then(Value::as_u64)
            .ok_or("Missing localId")? as u32;
        let expect = spec
            .get("expect")
            .and_then(Value::as_str)
            .ok_or("Missing expect")?;
        let element = find_scanned_target(local_id)?;
        let label = label_for(&element);
        let sensitive = is_sensitive(&element, label.as_deref());
        if sensitive && matches!(expect, "type" | "choose" | "submit") {
            return Err("Refusing to act on a secure field".into());
        }
        match expect {
            "click" | "submit" => element
                .get_pattern::<UIInvokePattern>()
                .and_then(|pattern| pattern.invoke())
                .map_err(|e| format!("No safe invoke action is available: {e}"))?,
            "type" => {
                let text = spec
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("Missing text")?;
                element
                    .get_pattern::<UIValuePattern>()
                    .and_then(|pattern| pattern.set_value(text))
                    .map_err(|e| format!("No safe value action is available: {e}"))?;
            }
            "choose" => {
                let option = spec
                    .get("option")
                    .and_then(Value::as_str)
                    .ok_or("Missing option")?;
                let (automation, _, _) = current_automation()?;
                let walker = automation.create_tree_walker().map_err(|e| e.to_string())?;
                if let Ok(expand) = element.get_pattern::<UIExpandCollapsePattern>() {
                    let _ = expand.expand();
                    thread::sleep(Duration::from_millis(100));
                }
                let mut pending = walker.get_children(&element).unwrap_or_default();
                let mut found = None;
                let mut seen = 0;
                while let Some(candidate) = pending.pop() {
                    seen += 1;
                    if seen > 300 {
                        break;
                    }
                    if candidate
                        .get_name()
                        .ok()
                        .map(|name| name.eq_ignore_ascii_case(option))
                        .unwrap_or(false)
                    {
                        found = Some(candidate);
                        break;
                    }
                    pending.extend(walker.get_children(&candidate).unwrap_or_default());
                }
                let choice = found.ok_or_else(|| {
                    "The requested option is not present in the current UI Automation tree"
                        .to_string()
                })?;
                choice
                    .get_pattern::<UISelectionItemPattern>()
                    .and_then(|pattern| pattern.select())
                    .map_err(|e| format!("No safe selection action is available: {e}"))?;
            }
            "scroll" => {
                // UIA's ScrollPattern is exposed on scroll containers rather than every child;
                // move the target into view through its pattern when available.
                element
                    .get_pattern::<uiautomation::patterns::UIScrollPattern>()
                    .and_then(|pattern| {
                        pattern.scroll(ScrollAmount::NoAmount, ScrollAmount::SmallIncrement)
                    })
                    .map_err(|e| format!("No safe scroll action is available: {e}"))?;
            }
            _ => return Err("Unsupported native action".into()),
        }
        Ok(())
    })();
    json!({ "ok": result.is_ok() })
}

pub fn clear() {
    if let Ok(mut target) = guide_rect().lock() {
        *target = None;
    }
    if let Ok(mut handle) = overlay_handle().lock() {
        if *handle != 0 {
            unsafe {
                let _ = DestroyWindow(windows::Win32::Foundation::HWND(*handle as *mut _));
            }
            *handle = 0;
        }
    }
}

pub fn pulse() {
    if let Ok(handle) = overlay_handle().lock() {
        if *handle != 0 {
            unsafe {
                let _ = ShowWindow(
                    windows::Win32::Foundation::HWND(*handle as *mut _),
                    SW_SHOWNOACTIVATE,
                );
            }
        }
    }
}

pub fn wait_for_change(timeout_ms: u64) -> bool {
    let (initial, initial_hwnd) = cache()
        .lock()
        .ok()
        .map(|state| (state.signature, state.hwnd))
        .unwrap_or((0, 0));
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(30_000));
    let Ok(automation) = automation() else {
        return false;
    };
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(150));
        let Ok(hwnd) = target_hwnd() else {
            return true;
        };
        if hwnd.0 as isize != initial_hwnd {
            emit_native("ja:page-changed", json!({ "reason": "navigation" }));
            return true;
        }
        let Ok(root) = automation.element_from_handle(Handle::from(hwnd)) else {
            return true;
        };
        if scan_window(&automation, &root, hwnd.0 as isize).is_err() {
            return true;
        }
        let current = cache()
            .lock()
            .ok()
            .map(|state| state.signature)
            .unwrap_or(initial);
        if current != initial {
            emit_native("ja:page-changed", json!({ "reason": "mutation" }));
            return true;
        }
    }
    false
}

/// Read a string value from the registry. `value` None reads the key's default value.
fn reg_string(root: HKEY, subkey: &str, value: Option<&str>) -> Option<String> {
    let subkey = HSTRING::from(subkey);
    let value = value.map(HSTRING::from);
    let value_ptr = value
        .as_ref()
        .map(|v| PCWSTR(v.as_ptr()))
        .unwrap_or(PCWSTR::null());
    unsafe {
        let mut size = 0u32;
        let first = RegGetValueW(
            root,
            &subkey,
            value_ptr,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        );
        if first != ERROR_SUCCESS || size < 2 {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        let second = RegGetValueW(
            root,
            &subkey,
            value_ptr,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        );
        if second != ERROR_SUCCESS {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }
}

/// The program path from a shell open command, like `"C:\...\chrome.exe" --single-argument %1`.
/// Takes the quoted part, or everything up to the first space. Must end in `.exe`.
fn exe_from_command(command: &str) -> Option<String> {
    let command = command.trim();
    let path = if let Some(rest) = command.strip_prefix('"') {
        &rest[..rest.find('"')?]
    } else {
        command.split_whitespace().next()?
    };
    let path = path.trim();
    (!path.is_empty() && path.to_ascii_lowercase().ends_with(".exe")).then(|| path.to_string())
}

/// Start `exe` with no arguments and don't wait for it.
fn launch_exe(exe: &str) -> bool {
    let path = std::path::Path::new(exe);
    if !path.is_file() || !exe.to_ascii_lowercase().ends_with(".exe") {
        return false;
    }
    std::process::Command::new(path).spawn().is_ok()
}

fn default_browser_exe() -> Option<String> {
    let prog_id = reg_string(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
        Some("ProgId"),
    )?;
    let prog_id = prog_id.trim();
    if prog_id.is_empty() || prog_id.contains('\\') {
        return None;
    }
    let command = reg_string(
        HKEY_CLASSES_ROOT,
        &format!(r"{prog_id}\shell\open\command"),
        None,
    )?;
    exe_from_command(&command)
}

/// Open her default browser at its own start page. No URL is ever passed: the browser is
/// started with no arguments. Falls back to Microsoft Edge.
pub fn open_browser() -> bool {
    if default_browser_exe().is_some_and(|exe| launch_exe(&exe)) {
        return true;
    }
    reg_string(
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
        None,
    )
    .and_then(|value| exe_from_command(&value))
    .is_some_and(|exe| launch_exe(&exe))
}

#[cfg(test)]
mod tests {
    use super::{exe_from_command, field_kind, is_candidate, looks_sensitive, role};
    use uiautomation::types::ControlType;

    #[test]
    fn browser_command_parser_takes_only_the_program_path() {
        assert_eq!(
            exe_from_command(
                r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1"#
            ),
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".into())
        );
        assert_eq!(
            exe_from_command(r#""C:\Program Files\Mozilla Firefox\firefox.exe""#),
            Some(r"C:\Program Files\Mozilla Firefox\firefox.exe".into())
        );
        assert_eq!(
            exe_from_command(r"C:\Browsers\browser.exe"),
            Some(r"C:\Browsers\browser.exe".into())
        );
        assert_eq!(
            exe_from_command(r#"C:\Browsers\browser.exe -osint -url "%1""#),
            Some(r"C:\Browsers\browser.exe".into())
        );
        assert_eq!(exe_from_command(r#""C:\Tools\open.cmd" %1"#), None);
        assert_eq!(exe_from_command(r#""C:\unterminated.exe %1"#), None);
        assert_eq!(exe_from_command("   "), None);
        assert_eq!(exe_from_command(r#""" %1"#), None);
    }

    #[test]
    fn secure_fields_are_sensitive_and_have_password_kind() {
        assert_eq!(field_kind(ControlType::Edit, true), Some("password"));
        assert_eq!(field_kind(ControlType::Edit, false), Some("text"));
    }

    #[test]
    fn roles_and_candidate_filter_cover_common_desktop_controls() {
        assert_eq!(role(ControlType::Button), "button");
        assert_eq!(role(ControlType::Edit), "textbox");
        assert!(is_candidate(ControlType::Button));
        assert!(!is_candidate(ControlType::Pane));
    }

    #[test]
    fn sensitive_label_classifier_covers_private_native_fields() {
        for label in [
            "One-time code",
            "Card number",
            "CVV",
            "Social Security Number",
            "Routing number",
            "Bank account",
            "PIN",
        ] {
            assert!(looks_sensitive(label), "expected {label:?} to be sensitive");
        }
        assert!(!looks_sensitive("Email address"));
    }
}
