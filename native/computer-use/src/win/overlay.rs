use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Once, OnceLock};
use std::thread;
use std::time::Instant;

use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DEFAULT_GUI_FONT, DeleteObject, EndPaint, FillRect,
    GetStockObject, HGDIOBJ, InvalidateRect, PAINTSTRUCT, SetBkMode, SetTextColor, TRANSPARENT,
    TextOutW, UpdateWindow,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect,
    GetMessageW, GetSystemMetrics, HWND_TOPMOST, LWA_ALPHA, MSG, PostQuitMessage, RegisterClassW,
    SM_CXSCREEN, SM_CYSCREEN, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow, TranslateMessage,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY, WM_PAINT, WM_TIMER, WNDCLASS_STYLES, WNDCLASSW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};
use windows::core::w;

const OVERLAY_WIDTH: i32 = 440;
const OVERLAY_HEIGHT: i32 = 64;
const OVERLAY_MARGIN: i32 = 56;
const IDLE_HIDE_MS: u64 = 4_000;
const COLOR_BACKGROUND: COLORREF = COLORREF(0x002A170F);
const COLOR_ACCENT: COLORREF = COLORREF(0x00FF9C33);
const COLOR_TEXT: COLORREF = COLORREF(0x00F8FAFC);

static START: Once = Once::new();
static LAST_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);
static VISIBLE: AtomicBool = AtomicBool::new(false);
static EPOCH: OnceLock<Instant> = OnceLock::new();

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

pub fn activity() {
    LAST_ACTIVITY_MS.store(now_ms().max(1), Ordering::Relaxed);
    START.call_once(|| {
        thread::spawn(|| {
            if let Err(error) = run_overlay() {
                eprintln!("computer-use overlay unavailable: {error}");
            }
        });
    });
}

fn run_overlay() -> windows::core::Result<()> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class_name = w!("ErebusComputerUseOverlay");
        let class = WNDCLASSW {
            style: WNDCLASS_STYLES(CS_HREDRAW.0 | CS_VREDRAW.0),
            lpfnWndProc: Some(overlay_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: HINSTANCE(instance.0),
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: CreateSolidBrush(COLOR_BACKGROUND),
            lpszMenuName: Default::default(),
            lpszClassName: class_name,
        };
        RegisterClassW(&class);

        let screen_width = GetSystemMetrics(SM_CXSCREEN);
        let screen_height = GetSystemMetrics(SM_CYSCREEN);
        let x = (screen_width - OVERLAY_WIDTH) / 2;
        let y = screen_height - OVERLAY_HEIGHT - OVERLAY_MARGIN;

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(
                WS_EX_LAYERED.0
                    | WS_EX_TRANSPARENT.0
                    | WS_EX_TOOLWINDOW.0
                    | WS_EX_NOACTIVATE.0
                    | WS_EX_TOPMOST.0,
            ),
            class_name,
            w!("Erebus Computer Use"),
            WINDOW_STYLE(0x80000000),
            x,
            y,
            OVERLAY_WIDTH,
            OVERLAY_HEIGHT,
            None,
            None,
            Some(HINSTANCE(instance.0)),
            None,
        )?;

        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 235, LWA_ALPHA);
        let _ = SetTimer(Some(hwnd), 1, 200, None);

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

fn update_visibility(hwnd: HWND) {
    let last = LAST_ACTIVITY_MS.load(Ordering::Relaxed);
    let active = last > 0 && now_ms().saturating_sub(last) < IDLE_HIDE_MS;
    let visible = VISIBLE.load(Ordering::Relaxed);
    if active == visible {
        return;
    }
    if active {
        VISIBLE.store(true, Ordering::Relaxed);
        unsafe {
            let screen_width = GetSystemMetrics(SM_CXSCREEN);
            let screen_height = GetSystemMetrics(SM_CYSCREEN);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                (screen_width - OVERLAY_WIDTH) / 2,
                screen_height - OVERLAY_HEIGHT - OVERLAY_MARGIN,
                OVERLAY_WIDTH,
                OVERLAY_HEIGHT,
                windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS(
                    SWP_NOACTIVATE.0 | SWP_SHOWWINDOW.0,
                ),
            );
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = InvalidateRect(Some(hwnd), None, false);
            let _ = UpdateWindow(hwnd);
        }
    } else {
        VISIBLE.store(false, Ordering::Relaxed);
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

fn paint(hwnd: HWND) {
    unsafe {
        let mut paint_struct = PAINTSTRUCT::default();
        let device_context = BeginPaint(hwnd, &mut paint_struct);
        let mut rect = RECT::default();
        let _ = GetClientRect(hwnd, &mut rect);

        let background = CreateSolidBrush(COLOR_BACKGROUND);
        let accent = CreateSolidBrush(COLOR_ACCENT);
        FillRect(device_context, &rect, background);
        let accent_bar = RECT {
            left: rect.left,
            top: rect.top,
            right: rect.left + 5,
            bottom: rect.bottom,
        };
        FillRect(device_context, &accent_bar, accent);

        SetBkMode(device_context, TRANSPARENT);
        let font = GetStockObject(DEFAULT_GUI_FONT);
        let previous = windows::Win32::Graphics::Gdi::SelectObject(device_context, font);

        SetTextColor(device_context, COLOR_TEXT);
        let title: Vec<u16> = "Erebus is using your computer".encode_utf16().collect();
        let _ = TextOutW(device_context, 22, 12, &title);

        SetTextColor(device_context, COLOR_ACCENT);
        let subtitle: Vec<u16> = "Computer Use".encode_utf16().collect();
        let _ = TextOutW(device_context, 22, 34, &subtitle);

        windows::Win32::Graphics::Gdi::SelectObject(device_context, previous);
        let _ = DeleteObject(HGDIOBJ(background.0));
        let _ = DeleteObject(HGDIOBJ(accent.0));
        let _ = EndPaint(hwnd, &paint_struct);
    }
}

unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            update_visibility(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}
