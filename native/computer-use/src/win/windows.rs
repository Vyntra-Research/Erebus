use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SW_RESTORE, SetForegroundWindow, ShowWindow, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

use crate::protocol::ToolError;

#[derive(Clone, Debug)]
pub struct WindowInfo {
    pub id: u64,
    pub app: String,
    pub display_name: String,
    pub title: String,
    pub is_foreground: bool,
}

pub fn list_windows() -> Result<Vec<WindowInfo>, ToolError> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_window),
            LPARAM(&mut windows as *mut Vec<WindowInfo> as isize),
        )
        .map_err(|error| ToolError::new("windows_error", error.to_string()))?;
    }
    Ok(windows)
}

unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let windows = unsafe { &mut *(lparam.0 as *mut Vec<WindowInfo>) };
    if let Some(info) = unsafe { info_for(hwnd) } {
        windows.push(info);
    }
    BOOL(1)
}

unsafe fn info_for(hwnd: HWND) -> Option<WindowInfo> {
    if hwnd.0.is_null() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return None;
    }
    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    if title_len <= 0 {
        return None;
    }
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return None;
    }
    if unsafe { is_cloaked(hwnd) } {
        return None;
    }
    let mut buffer = vec![0u16; title_len as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if copied <= 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&buffer[..copied as usize]);
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    }
    let app = process_path(pid);
    if app.is_empty() {
        return None;
    }
    let display_name = Path::new(&app)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&app)
        .to_string();
    Some(WindowInfo {
        id: hwnd.0 as usize as u64,
        app,
        display_name,
        title,
        is_foreground: unsafe { GetForegroundWindow() } == hwnd,
    })
}

fn process_path(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return String::new();
    };
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    }
    .is_ok();
    let _ = unsafe { CloseHandle(handle) };
    if !ok || size == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..size as usize])
}

unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    }
    .is_ok();
    ok && cloaked != 0
}

pub fn window_info(id: u64) -> Result<WindowInfo, ToolError> {
    let hwnd = hwnd(id);
    unsafe {
        info_for(hwnd).ok_or_else(|| {
            ToolError::new(
                "window_not_found",
                "The window is closed, hidden, or no longer targetable.",
            )
        })
    }
}

pub fn hwnd(id: u64) -> HWND {
    HWND(id as usize as *mut c_void)
}

/// Visible window bounds in physical screen pixels.
pub fn window_rect(id: u64) -> Result<(i32, i32, i32, i32), ToolError> {
    let hwnd = hwnd(id);
    let mut extended = RECT::default();
    let extended_ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut extended as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
    }
    .is_ok()
        && extended.right > extended.left
        && extended.bottom > extended.top;
    if extended_ok {
        return Ok((
            extended.left,
            extended.top,
            extended.right - extended.left,
            extended.bottom - extended.top,
        ));
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| ToolError::new("windows_error", error.to_string()))?;
    Ok((
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
    ))
}

pub fn activate_window(id: u64) -> Result<(), ToolError> {
    let hwnd = hwnd(id);
    if unsafe { IsIconic(hwnd) }.as_bool() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
    }
    unsafe {
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
    thread::sleep(Duration::from_millis(60));
    Ok(())
}

pub fn launch_app(app: &str) -> Result<(), ToolError> {
    let trimmed = app.trim();
    if trimmed.is_empty() {
        return Err(ToolError::invalid(
            "An app id or executable path is required.",
        ));
    }
    let mut command = if trimmed.contains('!') {
        let mut command = Command::new("explorer.exe");
        command.arg(format!("shell:AppsFolder\\{trimmed}"));
        command
    } else if trimmed.to_ascii_lowercase().ends_with(".exe") || trimmed.contains('\\') {
        Command::new(trimmed)
    } else {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "start", "", trimmed]);
        command
    };
    command
        .spawn()
        .map_err(|error| ToolError::new("launch_failed", error.to_string()))?;
    Ok(())
}
