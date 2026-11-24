use std::ffi::c_void;
use std::io::Cursor;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::protocol::ToolError;

const MAX_CAPTURE_DIMENSION: u32 = 1600;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(4);

pub struct Captured {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct EncodedScreenshot {
    pub width: u32,
    pub height: u32,
    pub base64: String,
}

struct OneShot {
    sender: mpsc::Sender<Result<Captured, String>>,
}

impl GraphicsCaptureApiHandler for OneShot {
    type Flags = mpsc::Sender<Result<Captured, String>>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            sender: context.flags,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let mut scratch = Vec::new();
        let captured = (|| -> Result<Captured, String> {
            let frame_buffer = frame.buffer().map_err(|error| error.to_string())?;
            let width = frame_buffer.width();
            let height = frame_buffer.height();
            let format = frame_buffer.color_format();
            let raw = frame_buffer.as_nopadding_buffer(&mut scratch);
            let mut rgba = raw.to_vec();
            if matches!(format, ColorFormat::Bgra8) {
                for pixel in rgba.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
            }
            Ok(Captured {
                width,
                height,
                rgba,
            })
        })();
        let _ = self.sender.send(captured);
        control.stop();
        Ok(())
    }
}

pub fn capture_window(window_id: u64) -> Result<Captured, ToolError> {
    let (sender, receiver) = mpsc::channel();
    let error_sender = sender.clone();
    let hwnd = window_id as usize;

    thread::spawn(move || {
        let window = Window::from_raw_hwnd(hwnd as *mut c_void);
        let settings = Settings::new(
            window,
            CursorCaptureSettings::WithoutCursor,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Exclude,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            sender,
        );
        if let Err(error) = OneShot::start(settings) {
            let _ = error_sender.send(Err(format!("{error}")));
        }
    });

    match receiver.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(Ok(captured)) => Ok(captured),
        Ok(Err(message)) => Err(ToolError::new("capture_failed", message)),
        Err(_) => Err(ToolError::new(
            "capture_timeout",
            "Windows Graphics Capture did not produce a frame in time. The window may be minimized or protected.",
        )),
    }
}

pub fn encode_screenshot(captured: Captured) -> Result<EncodedScreenshot, ToolError> {
    let image =
        RgbaImage::from_raw(captured.width, captured.height, captured.rgba).ok_or_else(|| {
            ToolError::new(
                "capture_failed",
                "Captured frame had an invalid pixel buffer.",
            )
        })?;

    let (width, height) = bounded_size(captured.width, captured.height);
    let image = if width != captured.width || height != captured.height {
        image::imageops::resize(&image, width, height, FilterType::Lanczos3)
    } else {
        image
    };

    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(image)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|error| ToolError::new("capture_failed", error.to_string()))?;

    Ok(EncodedScreenshot {
        width,
        height,
        base64: BASE64.encode(bytes),
    })
}

fn bounded_size(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= MAX_CAPTURE_DIMENSION || longest == 0 {
        return (width.max(1), height.max(1));
    }
    let scale = MAX_CAPTURE_DIMENSION as f64 / longest as f64;
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

#[allow(dead_code)]
fn _assert_item_type(_: GraphicsCaptureItemType) {}
