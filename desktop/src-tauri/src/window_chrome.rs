//! Native window-chrome behaviors: the sidebar haptic, title-bar
//! double-click handling, and the initial-window reveal sequence that keeps
//! the window hidden until restored geometry settles and React commits its
//! first frame.

#[cfg(target_os = "macos")]
pub(crate) const INITIAL_RENDER_READY_EVENT: &str = "initial-render-ready";

/// Plays the native macOS alignment haptic used when the sidebar snaps to
/// its default width. No-op on other platforms.
#[tauri::command]
pub fn perform_sidebar_default_haptic() {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };

        NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
            NSHapticFeedbackPattern::Alignment,
            NSHapticFeedbackPerformanceTime::Now,
        );
    }
}

/// Performs the window action matching the macOS "double-click a window's
/// title bar to" preference (`AppleActionOnDoubleClick`).
///
/// macOS values are `Minimize`, `Maximize` (default when unset), `Fill`, or
/// `None`.
/// The desktop app uses a web-based title-bar drag region, so the frontend
/// forwards double-clicks here and suppresses Tauri's injected drag-region
/// handler, whose default macOS path hardcodes maximize.
///
/// For `Fill`, resize to the current monitor work area instead of using
/// Tauri's maximize path, which maps to macOS zoom for titled, resizable
/// windows.
///
/// On non-macOS platforms this always toggles maximize (the historical
/// behavior).
#[tauri::command]
pub fn title_bar_double_click(window: tauri::Window) {
    #[cfg(target_os = "macos")]
    {
        let action = {
            let output = std::process::Command::new("defaults")
                .args(["read", "-g", "AppleActionOnDoubleClick"])
                .output();
            match output {
                Ok(output) if output.status.success() => {
                    String::from_utf8_lossy(&output.stdout).trim().to_string()
                }
                _ => "Maximize".to_string(),
            }
        };

        match action.as_str() {
            "None" => {}
            "Minimize" => {
                let _ = window.minimize();
            }
            "Fill" => {
                fill_window(&window);
            }
            // "Maximize" or any unexpected value.
            _ => {
                toggle_maximize(&window);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        toggle_maximize(&window);
    }
}

/// Fills the current display work area, excluding system UI like the menu bar
/// and Dock.
#[cfg(target_os = "macos")]
fn fill_window(window: &tauri::Window) {
    match window.current_monitor() {
        Ok(Some(monitor)) => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            }

            let work_area = monitor.work_area();
            let _ = window.set_position(work_area.position);
            let _ = window.set_size(work_area.size);
        }
        _ => {
            let _ = window.maximize();
        }
    }
}

/// Toggles the window between maximized and its previous size, matching the
/// historical double-click behavior.
fn toggle_maximize(window: &tauri::Window) {
    match window.is_maximized() {
        Ok(true) => {
            let _ = window.unmaximize();
        }
        _ => {
            let _ = window.maximize();
        }
    }
}

pub(crate) fn reveal_initial_window<R: tauri::Runtime>(window: &tauri::Window<R>) {
    if let Err(error) = window.show() {
        eprintln!("buzz-desktop: failed to reveal main window: {error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        eprintln!("buzz-desktop: failed to focus main window: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_initial_window_backing<R: tauri::Runtime>(window: &tauri::Window<R>) {
    // The window remains transparent at runtime for vibrancy. Use an opaque
    // native backing only across the first visible frames so the previous app
    // cannot show through before WebKit has submitted its first surface.
    if let Err(error) = window.set_background_color(Some(tauri::window::Color(17, 21, 24, 255))) {
        eprintln!("buzz-desktop: failed to set initial window backing: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn clear_initial_window_backing<R: tauri::Runtime>(window: &tauri::Window<R>) {
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    if let Err(error) = window.set_background_color(None) {
        eprintln!("buzz-desktop: failed to clear initial window backing: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn wait_for_stable_initial_window_geometry<R: tauri::Runtime>(
    window: &tauri::Window<R>,
) {
    const MAX_POLLS: usize = 120;
    const REQUIRED_STABLE_POLLS: usize = 4;

    let mut previous_bounds = None;
    let mut stable_polls = 0;

    for _ in 0..MAX_POLLS {
        // Accept whatever geometry the window-state plugin restores — maximized
        // or a normal saved size. macOS applies the restore asynchronously, so
        // we only need consecutive identical outer bounds to know it settled.
        // Gating on `is_maximized()` here would leave `bounds` permanently
        // `None` for restored non-maximized windows and stall the reveal until
        // the poll timeout.
        let bounds = match (window.outer_position(), window.outer_size()) {
            (Ok(position), Ok(size)) => Some((position.x, position.y, size.width, size.height)),
            _ => None,
        };

        if bounds.is_some() && bounds == previous_bounds {
            stable_polls += 1;
            if stable_polls >= REQUIRED_STABLE_POLLS {
                return;
            }
        } else {
            stable_polls = 0;
        }
        previous_bounds = bounds;

        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }

    eprintln!("buzz-desktop: initial window geometry did not settle before reveal timeout");
}
