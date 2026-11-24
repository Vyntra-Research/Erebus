pub mod capture;
pub mod input;
pub mod overlay;
pub mod uia;
pub mod windows;

mod state;

pub use state::ComputerUse;

use ::windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use ::windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

pub fn init_process() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}
