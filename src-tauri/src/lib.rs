#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicI32, AtomicPtr, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use core_foundation::{
    base::{CFRelease, CFTypeRef, TCFType},
    string::{CFString, CFStringRef},
};
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, rc::Retained, runtime::AnyObject, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
    NSAutoresizingMaskOptions, NSBackingStoreType, NSColor, NSEvent, NSEventMask,
    NSFloatingWindowLevel, NSPanel, NSPasteboard, NSRunningApplication, NSScreen, NSView, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveApplication {
    name: Option<String>,
    bundle_id: Option<String>,
    pid: Option<i32>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherWakePayload {
    surface: &'static str,
    app: Option<ActiveApplication>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionStreamPayload {
    request_id: String,
    chunk: Option<String>,
    done: bool,
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardTextAndHtml {
    text: String,
    html: String,
}

const HISTORY_SHORTCUT: &str = "Command+Shift+V";
const SNIPPETS_SHORTCUT: &str = "Command+Option+Shift+V";
const ASK_SHORTCUT: &str = "Option+Space";
const PANEL_WIDTH: f64 = 748.0;
const PANEL_HEIGHT: f64 = 548.0;
const SEARCH_CENTER_Y: f64 = 31.0;
const LLM_TIMEOUT_SECS: u64 = 90;

#[cfg(target_os = "macos")]
static LAUNCHER_PANEL: AtomicPtr<CliboardPanel> = AtomicPtr::new(std::ptr::null_mut());
#[cfg(target_os = "macos")]
static LAUNCHER_WEBVIEW: AtomicPtr<NSView> = AtomicPtr::new(std::ptr::null_mut());
#[cfg(target_os = "macos")]
static LAUNCHER_HOST_VIEW: AtomicPtr<NSView> = AtomicPtr::new(std::ptr::null_mut());
#[cfg(target_os = "macos")]
static TARGET_APP_PID: AtomicI32 = AtomicI32::new(0);
#[cfg(target_os = "macos")]
static TARGET_WINDOW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
#[cfg(target_os = "macos")]
static OUTSIDE_CLICK_MONITOR: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementPerformAction(element: CFTypeRef, action: CFStringRef) -> i32;
    static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
}

#[cfg(target_os = "macos")]
define_class!(
  #[unsafe(super(NSPanel))]
  #[thread_kind = MainThreadOnly]
  struct CliboardPanel;

  impl CliboardPanel {
    #[unsafe(method(canBecomeKeyWindow))]
    fn can_become_key_window(&self) -> bool {
      true
    }

    #[unsafe(method(canBecomeMainWindow))]
    fn can_become_main_window(&self) -> bool {
      true
    }
  }
);

#[cfg(target_os = "macos")]
impl CliboardPanel {
    fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
        let panel = Self::alloc(mtm);
        unsafe {
            msg_send![
              panel,
              initWithContentRect: frame,
              styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
              backing: NSBackingStoreType::Buffered,
              defer: false
            ]
        }
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if max <= min {
        min
    } else {
        value.max(min).min(max)
    }
}

fn mouse_launcher_position<R: Runtime>(
    app: &tauri::AppHandle<R>,
    panel_width: f64,
    panel_height: f64,
) -> Option<(PhysicalPosition<i32>, f64)> {
    let cursor = app.cursor_position().ok()?;
    let preferred_x = cursor.x - 80.0;

    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let scale = monitor.scale_factor();
            let preferred_y = cursor.y - SEARCH_CENTER_Y * scale;
            let origin_x = monitor.position().x as f64;
            let origin_y = monitor.position().y as f64;
            let width = monitor.size().width as f64;
            let height = monitor.size().height as f64;
            let inside_x = cursor.x >= origin_x && cursor.x <= origin_x + width;
            let inside_y = cursor.y >= origin_y && cursor.y <= origin_y + height;
            if inside_x && inside_y {
                let margin = 16.0 * scale;
                let panel_width = panel_width * scale;
                let panel_height = panel_height * scale;
                let max_x = origin_x + width - panel_width - margin;
                let max_y = origin_y + height - panel_height - margin;
                let above_y = cursor.y - panel_height - 18.0 * scale;
                let target_y = if preferred_y + panel_height <= origin_y + height - margin {
                    preferred_y
                } else {
                    above_y
                };
                return Some((
                    PhysicalPosition::new(
                        clamp(preferred_x, origin_x + margin, max_x).round() as i32,
                        clamp(target_y, origin_y + margin, max_y).round() as i32,
                    ),
                    scale,
                ));
            }
        }
    }

    Some((
        PhysicalPosition::new(
            preferred_x.max(16.0).round() as i32,
            (cursor.y - SEARCH_CENTER_Y).max(16.0).round() as i32,
        ),
        1.0,
    ))
}

#[cfg(target_os = "macos")]
fn rect_contains_point(rect: NSRect, point: NSPoint) -> bool {
    point.x >= rect.origin.x
        && point.x <= rect.origin.x + rect.size.width
        && point.y >= rect.origin.y
        && point.y <= rect.origin.y + rect.size.height
}

#[cfg(target_os = "macos")]
fn visible_frame_for_mouse(mtm: MainThreadMarker, point: NSPoint) -> Option<NSRect> {
    let screens = NSScreen::screens(mtm);
    for screen in screens.iter() {
        if rect_contains_point(screen.frame(), point) {
            return Some(screen.visibleFrame());
        }
    }
    NSScreen::mainScreen(mtm).map(|screen| screen.visibleFrame())
}

#[cfg(target_os = "macos")]
fn native_mouse_launcher_top_left(mtm: MainThreadMarker) -> NSPoint {
    let mouse = NSEvent::mouseLocation();
    let visible = visible_frame_for_mouse(mtm, mouse).unwrap_or_else(|| {
        NSRect::new(
            NSPoint::new(16.0, 16.0),
            NSSize::new(PANEL_WIDTH + 32.0, PANEL_HEIGHT + 32.0),
        )
    });
    let margin = 16.0;
    let min_x = visible.origin.x + margin;
    let max_x = visible.origin.x + visible.size.width - PANEL_WIDTH - margin;
    let min_top_y = visible.origin.y + PANEL_HEIGHT + margin;
    let max_top_y = visible.origin.y + visible.size.height - margin;

    NSPoint::new(
        clamp(mouse.x - 80.0, min_x, max_x),
        clamp(mouse.y + SEARCH_CENTER_Y, min_top_y, max_top_y),
    )
}

#[cfg(target_os = "macos")]
fn configure_launcher_panel<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    if ns_window.is_null() {
        return Err("Missing native NSWindow".into());
    }

    unsafe {
        let ns_window = &*ns_window;
        ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        ns_window.setLevel(NSFloatingWindowLevel);
        ns_window.setHidesOnDeactivate(false);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn configure_launcher_panel<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn focus_launcher_panel<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    if ns_window.is_null() {
        return Err("Missing native NSWindow".into());
    }

    unsafe {
        let ns_window = &*ns_window;
        ns_window.makeKeyAndOrderFront(None::<&AnyObject>);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn point_in_rect(point: NSPoint, rect: NSRect) -> bool {
    point.x >= rect.origin.x
        && point.x <= rect.origin.x + rect.size.width
        && point.y >= rect.origin.y
        && point.y <= rect.origin.y + rect.size.height
}

#[cfg(target_os = "macos")]
fn install_outside_click_monitor() {
    if !OUTSIDE_CLICK_MONITOR.load(Ordering::SeqCst).is_null() {
        return;
    }

    let mask =
        NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown;
    let block = RcBlock::new(|_event: NonNull<NSEvent>| {
        let panel = LAUNCHER_PANEL.load(Ordering::SeqCst);
        if panel.is_null() {
            return;
        }

        unsafe {
            let panel = &*panel;
            if !panel.isVisible() {
                return;
            }
            if !point_in_rect(NSEvent::mouseLocation(), panel.frame()) {
                let _ = hide_native_launcher_panel();
            }
        }
    });

    if let Some(monitor) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &block) {
        OUTSIDE_CLICK_MONITOR.store(Retained::into_raw(monitor), Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
fn hide_native_launcher_panel() -> Result<(), String> {
    let panel = LAUNCHER_PANEL.load(Ordering::SeqCst);
    if panel.is_null() {
        return Err("Native launcher panel is not active".into());
    }
    unsafe {
        (&*panel).orderOut(None::<&AnyObject>);
        let webview = LAUNCHER_WEBVIEW.load(Ordering::SeqCst);
        let host_view = LAUNCHER_HOST_VIEW.load(Ordering::SeqCst);
        if !webview.is_null() && !host_view.is_null() {
            (&*panel).setContentView(None);
            let webview = &*webview;
            let host_view = &*host_view;
            webview.removeFromSuperview();
            webview.setFrame(NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(PANEL_WIDTH, PANEL_HEIGHT),
            ));
            host_view.addSubview(webview);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_native_launcher_panel_drag() -> Result<(), String> {
    let panel = LAUNCHER_PANEL.load(Ordering::SeqCst);
    if panel.is_null() {
        return Err("Native launcher panel is not active".into());
    }

    let mtm = MainThreadMarker::new().ok_or_else(|| "Not on main thread".to_string())?;
    let panel = unsafe { &*panel };
    let event = panel
        .currentEvent()
        .or_else(|| NSApplication::sharedApplication(mtm).currentEvent())
        .ok_or_else(|| "Missing mouse event for panel drag".to_string())?;
    panel.performWindowDragWithEvent(&event);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn start_native_launcher_panel_drag() -> Result<(), String> {
    Err("Native panel dragging is only available on macOS".into())
}

#[cfg(target_os = "macos")]
fn show_native_launcher_panel<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or_else(|| "Not on main thread".to_string())?;
    let top_left = native_mouse_launcher_top_left(mtm);
    let frame = NSRect::new(
        NSPoint::new(top_left.x, top_left.y - PANEL_HEIGHT),
        NSSize::new(PANEL_WIDTH, PANEL_HEIGHT),
    );

    let content_view = unsafe {
        let tauri_ns_window =
            window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
        if tauri_ns_window.is_null() {
            return Err("Missing native NSWindow".into());
        }
        let tauri_ns_window = &*tauri_ns_window;
        let content_view = tauri_ns_window
            .contentView()
            .ok_or_else(|| "Missing Tauri content view".to_string())?;
        if LAUNCHER_HOST_VIEW.load(Ordering::SeqCst).is_null() {
            LAUNCHER_HOST_VIEW.store(Retained::into_raw(content_view.clone()), Ordering::SeqCst);
        }
        tauri_ns_window.orderOut(None::<&objc2::runtime::AnyObject>);
        content_view
    };

    let mut webview = LAUNCHER_WEBVIEW.load(Ordering::SeqCst);
    if webview.is_null() {
        let subviews = content_view.subviews();
        let first_subview = subviews
            .firstObject()
            .ok_or_else(|| "Missing Tauri webview subview".to_string())?;
        webview = Retained::into_raw(first_subview);
        LAUNCHER_WEBVIEW.store(webview, Ordering::SeqCst);
    }

    if webview.is_null() {
        return Err("Missing native WebView".into());
    }

    let mut panel = LAUNCHER_PANEL.load(Ordering::SeqCst);
    if panel.is_null() {
        let retained_panel = CliboardPanel::new(mtm, frame);
        unsafe { retained_panel.setReleasedWhenClosed(false) };
        retained_panel.setFloatingPanel(true);
        retained_panel.setBecomesKeyOnlyIfNeeded(false);
        retained_panel.setWorksWhenModal(true);
        retained_panel.setLevel(NSFloatingWindowLevel);
        retained_panel.setHidesOnDeactivate(false);
        retained_panel.setMovableByWindowBackground(true);
        retained_panel.setOpaque(false);
        retained_panel.setHasShadow(true);
        retained_panel.setBackgroundColor(Some(&NSColor::clearColor()));
        retained_panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel = Retained::into_raw(retained_panel);
        LAUNCHER_PANEL.store(panel, Ordering::SeqCst);
    }

    if panel.is_null() {
        return Err("Failed to create launcher panel".into());
    }
    let panel = unsafe { &*panel };
    unsafe {
        let webview = &*webview;
        webview.removeFromSuperview();
        webview.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(PANEL_WIDTH, PANEL_HEIGHT),
        ));
        webview.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        panel.setContentView(Some(webview));
    }
    panel.setFrame_display(frame, true);
    panel.setFrameTopLeftPoint(top_left);
    install_outside_click_monitor();
    panel.orderFrontRegardless();
    panel.makeKeyWindow();
    unsafe {
        panel.makeFirstResponder(Some((&*webview).as_ref()));
    }

    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn focus_launcher_panel<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn hide_native_launcher_panel() -> Result<(), String> {
    Ok(())
}

fn show_launcher<R: Runtime>(app: &tauri::AppHandle<R>, surface: &'static str) {
    let active_app = active_application();
    remember_target_application(active_app.as_ref());
    let wake_payload = LauncherWakePayload {
        surface,
        app: active_app,
    };
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            if show_native_launcher_panel(&window).is_err() {
                let position = mouse_launcher_position(app, PANEL_WIDTH, PANEL_HEIGHT)
                    .map(|(position, _)| position);
                let _ = configure_launcher_panel(&window);
                let _ = window.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT));
                if let Some(position) = position {
                    let _ = window.set_position(position);
                } else {
                    let _ = window.center();
                }
                let _ = window.show();
                let _ = focus_launcher_panel(&window);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let position = mouse_launcher_position(app, PANEL_WIDTH, PANEL_HEIGHT)
                .map(|(position, _)| position);
            let _ = configure_launcher_panel(&window);
            let _ = window.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT));
            if let Some(position) = position {
                let _ = window.set_position(position);
            } else {
                let _ = window.center();
            }
            let _ = window.show();
            let _ = focus_launcher_panel(&window);
        }
        let _ = window.emit("launcher-wake", wake_payload);
    }
}

fn register_launcher_shortcut<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shortcut: &'static str,
    surface: &'static str,
) {
    match app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            #[cfg(debug_assertions)]
            println!("Cliboard shortcut event: {shortcut} {event:?}");
            if event.state == ShortcutState::Pressed {
                show_launcher(app, surface);
            }
        }) {
        Ok(()) => {
            #[cfg(debug_assertions)]
            {
                let registered = app.global_shortcut().is_registered(shortcut);
                println!("Cliboard registered shortcut {shortcut}: {registered}");
            }
        }
        Err(error) => {
            eprintln!("Cliboard failed to register shortcut {shortcut}: {error}");
        }
    }
}

#[cfg(target_os = "macos")]
fn ns_string_to_string(value: &objc2_foundation::NSString) -> String {
    use std::ffi::CStr;

    unsafe {
        let ptr = value.UTF8String();
        if ptr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}

#[cfg(target_os = "macos")]
fn remember_target_application(app: Option<&ActiveApplication>) {
    let pid = app.and_then(|app| app.pid).unwrap_or_default();
    TARGET_APP_PID.store(pid.max(0), Ordering::SeqCst);
    replace_target_window(
        (pid > 0)
            .then(|| focused_window_for_application(pid))
            .flatten(),
    );
}

#[cfg(not(target_os = "macos"))]
fn remember_target_application(_app: Option<&ActiveApplication>) {}

#[cfg(target_os = "macos")]
fn replace_target_window(window: Option<CFTypeRef>) {
    let new_window = window.unwrap_or(std::ptr::null());
    let old_window = TARGET_WINDOW.swap(new_window.cast_mut().cast(), Ordering::SeqCst);
    if !old_window.is_null() {
        unsafe {
            CFRelease(old_window.cast());
        }
    }
}

#[cfg(target_os = "macos")]
fn focused_window_for_application(pid: i32) -> Option<CFTypeRef> {
    if unsafe { !AXIsProcessTrusted() } {
        return None;
    }

    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return None;
    }

    let attribute = CFString::new("AXFocusedWindow");
    let mut window: CFTypeRef = std::ptr::null();
    let result =
        unsafe { AXUIElementCopyAttributeValue(app, attribute.as_concrete_TypeRef(), &mut window) };
    unsafe {
        CFRelease(app);
    }

    if result == 0 && !window.is_null() {
        Some(window)
    } else {
        if !window.is_null() {
            unsafe {
                CFRelease(window);
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
fn raise_target_window() -> bool {
    if unsafe { !AXIsProcessTrusted() } {
        return false;
    }

    let window = TARGET_WINDOW.load(Ordering::SeqCst);
    if window.is_null() {
        return false;
    }

    let action = CFString::new("AXRaise");
    unsafe { AXUIElementPerformAction(window.cast(), action.as_concrete_TypeRef()) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn raise_target_window() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn activate_target_application() -> bool {
    let pid = TARGET_APP_PID.load(Ordering::SeqCst);
    if pid <= 0 {
        return false;
    }

    let Some(target_app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
    else {
        return false;
    };
    if target_app.isTerminated() {
        return false;
    }

    let mtm = match MainThreadMarker::new() {
        Some(mtm) => mtm,
        None => return false,
    };
    let app = NSApplication::sharedApplication(mtm);
    app.yieldActivationToApplication(&target_app);
    let requested = target_app.activateWithOptions(NSApplicationActivationOptions::empty());
    for _ in 0..6 {
        if target_app.isActive() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    requested
}

#[cfg(not(target_os = "macos"))]
fn activate_target_application() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn request_accessibility_permission() -> bool {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;

    if unsafe { AXIsProcessTrusted() } {
        return true;
    }

    let prompt_key = unsafe { CFType::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let prompt_value = CFBoolean::true_value().as_CFType();
    let options = CFDictionary::from_CFType_pairs(&[(prompt_key, prompt_value)]);

    unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef() as *const std::ffi::c_void) }
}

#[cfg(target_os = "macos")]
fn active_application() -> Option<ActiveApplication> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let name = app
        .localizedName()
        .map(|value| ns_string_to_string(&value))
        .filter(|value| !value.trim().is_empty());
    let bundle_id = app
        .bundleIdentifier()
        .map(|value| ns_string_to_string(&value))
        .filter(|value| !value.trim().is_empty());
    let pid = {
        let value = app.processIdentifier();
        (value > 0).then_some(value as i32)
    };

    if name.is_none() && bundle_id.is_none() && pid.is_none() {
        None
    } else {
        Some(ActiveApplication {
            name,
            bundle_id,
            pid,
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn active_application() -> Option<ActiveApplication> {
    None
}

#[cfg(target_os = "macos")]
fn system_clipboard_change_count() -> Option<i64> {
    Some(NSPasteboard::generalPasteboard().changeCount() as i64)
}

#[cfg(not(target_os = "macos"))]
fn system_clipboard_change_count() -> Option<i64> {
    None
}

#[cfg(target_os = "macos")]
fn post_command_v() -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const KEYCODE_V: u16 = 9;

    if !request_accessibility_permission() {
        return Err("Cliboard needs Accessibility permission to auto-paste".into());
    }

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "Failed to create keyboard event source".to_string())?;
    let key_down = CGEvent::new_keyboard_event(source.clone(), KEYCODE_V, true)
        .map_err(|_| "Failed to create paste key-down event".to_string())?;
    let key_up = CGEvent::new_keyboard_event(source, KEYCODE_V, false)
        .map_err(|_| "Failed to create paste key-up event".to_string())?;

    let command_flags =
        CGEventFlags::from_bits_truncate(CGEventFlags::CGEventFlagCommand.bits() | 0x000008);
    key_down.set_flags(command_flags);
    key_up.set_flags(command_flags);
    key_down.post(CGEventTapLocation::Session);
    key_up.post(CGEventTapLocation::Session);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn post_command_v() -> Result<(), String> {
    Err("Paste automation is only available on macOS".into())
}

#[tauri::command]
async fn chat_completion(
    base_url: String,
    api_key: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("Missing API key".into());
    }

    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
        .build()
        .map_err(|error| error.to_string())?
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;

    if !status.is_success() {
        return Err(format!("LLM request failed: {status} {text}"));
    }

    serde_json::from_str(&text).map_err(|error| error.to_string())
}

#[tauri::command]
async fn chat_completion_stream(
    window: tauri::Window,
    request_id: String,
    base_url: String,
    api_key: String,
    mut body: serde_json::Value,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("Missing API key".into());
    }

    if let Some(object) = body.as_object_mut() {
        object.insert("stream".into(), serde_json::Value::Bool(true));
    }

    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
        .build()
        .map_err(|error| error.to_string())?
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.map_err(|error| error.to_string())?;
        return Err(format!("LLM request failed: {status} {text}"));
    }

    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        window
            .emit(
                "chat-completion-stream",
                ChatCompletionStreamPayload {
                    request_id: request_id.clone(),
                    chunk: Some(String::from_utf8_lossy(&chunk).into_owned()),
                    done: false,
                    error: None,
                },
            )
            .map_err(|error| error.to_string())?;
    }

    window
        .emit(
            "chat-completion-stream",
            ChatCompletionStreamPayload {
                request_id,
                chunk: None,
                done: true,
                error: None,
            },
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    let files = clipboard
        .get()
        .file_list()
        .map_err(|error| error.to_string())?;

    Ok(files
        .into_iter()
        .filter_map(|path| path.to_str().map(ToOwned::to_owned))
        .collect())
}

#[tauri::command]
fn write_clipboard_files(files: Vec<String>) -> Result<(), String> {
    let paths: Vec<PathBuf> = files
        .into_iter()
        .filter(|file| !file.trim().is_empty())
        .map(PathBuf::from)
        .collect();

    if paths.is_empty() {
        return Err("No files to write".into());
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set()
        .file_list(&paths)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_clipboard_html() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.get().html().map_err(|error| error.to_string())
}

#[tauri::command]
fn read_clipboard_text_and_html() -> Result<ClipboardTextAndHtml, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    let text = clipboard.get().text().unwrap_or_default();
    let html = clipboard.get().html().unwrap_or_default();
    Ok(ClipboardTextAndHtml { text, html })
}

#[tauri::command]
fn write_clipboard_html(html: String, alt_text: Option<String>) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err("No HTML to write".into());
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_html(html, alt_text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_active_application() -> Option<ActiveApplication> {
    active_application()
}

#[tauri::command]
fn clipboard_change_count() -> Option<i64> {
    system_clipboard_change_count()
}

#[tauri::command]
fn paste_to_frontmost_app() -> Result<(), String> {
    post_command_v()
}

#[tauri::command]
fn paste_after_hiding_launcher_panel() -> Result<(), String> {
    let _ = hide_native_launcher_panel();
    let raised_target = raise_target_window();
    let restored_target = activate_target_application();
    std::thread::sleep(Duration::from_millis(if raised_target || restored_target {
        15
    } else {
        10
    }));
    post_command_v()
}

#[tauri::command]
fn hide_launcher_panel() -> Result<(), String> {
    hide_native_launcher_panel()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    let _ = hide_native_launcher_panel();
    app.exit(0);
}

#[tauri::command]
fn start_launcher_panel_drag() -> Result<(), String> {
    start_native_launcher_panel_drag()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            chat_completion,
            chat_completion_stream,
            clipboard_change_count,
            hide_launcher_panel,
            paste_after_hiding_launcher_panel,
            paste_to_frontmost_app,
            quit_app,
            read_active_application,
            read_clipboard_files,
            read_clipboard_html,
            read_clipboard_text_and_html,
            start_launcher_panel_drag,
            write_clipboard_files,
            write_clipboard_html,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            register_launcher_shortcut(app.handle(), HISTORY_SHORTCUT, "history");
            register_launcher_shortcut(app.handle(), SNIPPETS_SHORTCUT, "snippets");
            register_launcher_shortcut(app.handle(), ASK_SHORTCUT, "ask");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
