use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use serde_json::{Value, json};
use uiautomation::UIElement;
use uiautomation::core::UIAutomation;

use crate::protocol::ToolError;
use crate::win::{capture, input, uia, windows};

pub struct ComputerUse {
    automation: Option<UIAutomation>,
    snapshots: HashMap<u64, Snapshot>,
    captures: HashMap<u64, CaptureMapping>,
}

struct Snapshot {
    elements: Vec<UIElement>,
}

struct CaptureMapping {
    origin_x: i32,
    origin_y: i32,
    scale_x: f64,
    scale_y: f64,
}

impl ComputerUse {
    pub fn new() -> Self {
        Self {
            automation: UIAutomation::new().ok(),
            snapshots: HashMap::new(),
            captures: HashMap::new(),
        }
    }

    pub fn dispatch(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
        crate::win::overlay::activity();
        match method {
            "list_apps" => self.list_apps(),
            "list_windows" => self.list_windows(),
            "launch_app" => self.launch_app(parse(params)?),
            "get_window_state" => self.get_window_state(parse(params)?),
            "activate_window" => self.activate_window(parse(params)?),
            "click" => self.click(parse(params)?),
            "type_text" => self.type_text(parse(params)?),
            "press_key" => self.press_key(parse(params)?),
            "scroll" => self.scroll(parse(params)?),
            "set_value" => self.set_value(parse(params)?),
            "drag" => self.drag(parse(params)?),
            "secondary_action" => self.secondary_action(parse(params)?),
            other => Err(ToolError::new(
                "unknown_method",
                format!("Unknown computer-use method '{other}'."),
            )),
        }
    }

    fn list_apps(&mut self) -> Result<Value, ToolError> {
        let windows = windows::list_windows()?;
        let mut apps: BTreeMap<String, (String, Vec<Value>)> = BTreeMap::new();
        for window in windows {
            apps.entry(window.app.clone())
                .or_insert_with(|| (window.display_name.clone(), Vec::new()))
                .1
                .push(window_json(&window));
        }
        let apps: Vec<Value> = apps
            .into_iter()
            .map(|(id, (display_name, windows))| {
                json!({
                    "id": id,
                    "displayName": display_name,
                    "isRunning": true,
                    "windows": windows,
                })
            })
            .collect();
        Ok(json!({ "apps": apps }))
    }

    fn list_windows(&mut self) -> Result<Value, ToolError> {
        let windows: Vec<Value> = windows::list_windows()?.iter().map(window_json).collect();
        Ok(json!({ "windows": windows }))
    }

    fn launch_app(&mut self, params: LaunchParams) -> Result<Value, ToolError> {
        windows::launch_app(&params.app)?;
        Ok(json!({ "launched": true, "app": params.app }))
    }

    fn get_window_state(&mut self, params: GetWindowStateParams) -> Result<Value, ToolError> {
        let info = windows::window_info(params.window_id)?;

        let screenshot = if params.include_screenshot {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let captured = capture::capture_window(params.window_id)?;
            let encoded = capture::encode_screenshot(captured)?;
            let (origin_x, origin_y, width, height) = windows::window_rect(params.window_id)?;
            let scale_x = width as f64 / encoded.width as f64;
            let scale_y = height as f64 / encoded.height as f64;
            self.captures.insert(
                params.window_id,
                CaptureMapping {
                    origin_x,
                    origin_y,
                    scale_x,
                    scale_y,
                },
            );
            Some(json!({
                "mimeType": "image/png",
                "data": encoded.base64,
                "width": encoded.width,
                "height": encoded.height,
                "scaleX": scale_x,
                "scaleY": scale_y,
            }))
        } else {
            self.captures.remove(&params.window_id);
            None
        };

        let accessibility = if params.include_text {
            let automation = self.automation.as_ref().ok_or_else(|| {
                ToolError::new(
                    "uia_unavailable",
                    "UI Automation is unavailable in this process.",
                )
            })?;
            let tree = uia::capture_tree(automation, params.window_id)?;
            self.snapshots.insert(
                params.window_id,
                Snapshot {
                    elements: tree.elements,
                },
            );
            Some(json!({
                "tree": tree.text,
                "focusedElement": tree.focused_element,
                "documentText": tree.document_text,
            }))
        } else {
            self.snapshots.remove(&params.window_id);
            None
        };

        Ok(json!({
            "window": window_json(&info),
            "screenshot": screenshot,
            "accessibility": accessibility,
        }))
    }

    fn activate_window(&mut self, params: WindowParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        let info = windows::window_info(params.window_id)?;
        Ok(json!({ "window": window_json(&info) }))
    }

    fn click(&mut self, params: ClickParams) -> Result<Value, ToolError> {
        let button = normalized_button(params.mouse_button.as_deref());
        let count = params.click_count.unwrap_or(1).clamp(1, 3);
        windows::activate_window(params.window_id)?;

        if let Some(index) = params.element_index {
            let element = self.element(params.window_id, index)?;
            uia::click_element(&element, &button, count)?;
        } else if let (Some(x), Some(y)) = (params.x, params.y) {
            let mapping = self.capture_mapping(params.window_id)?;
            let (x, y) = map_point(mapping, x, y);
            input::click_at(x, y, &button, count);
        } else {
            return Err(ToolError::invalid(
                "Provide elementIndex or both x and y from the latest screenshot.",
            ));
        }
        Ok(json!({ "completed": true }))
    }

    fn type_text(&mut self, params: TypeTextParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        input::type_text(&params.text);
        Ok(json!({ "completed": true, "characters": params.text.chars().count() }))
    }

    fn press_key(&mut self, params: PressKeyParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        input::press_chord(&params.key)?;
        Ok(json!({ "completed": true }))
    }

    fn scroll(&mut self, params: ScrollParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        let (x, y) = match (params.x, params.y) {
            (Some(x), Some(y)) => {
                let mapping = self.capture_mapping(params.window_id)?;
                map_point(mapping, x, y)
            }
            _ => {
                let (origin_x, origin_y, width, height) = windows::window_rect(params.window_id)?;
                (origin_x + width / 2, origin_y + height / 2)
            }
        };
        input::scroll_at(x, y, params.scroll_x, params.scroll_y);
        Ok(json!({ "completed": true }))
    }

    fn set_value(&mut self, params: SetValueParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        let element = self.element(params.window_id, params.element_index)?;
        uia::set_value(&element, &params.value)?;
        Ok(json!({ "completed": true }))
    }

    fn drag(&mut self, params: DragParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        let mapping = self.capture_mapping(params.window_id)?;
        let (from_x, from_y) = map_point(mapping, params.from_x, params.from_y);
        let (to_x, to_y) = map_point(mapping, params.to_x, params.to_y);
        input::drag(from_x, from_y, to_x, to_y);
        Ok(json!({ "completed": true }))
    }

    fn secondary_action(&mut self, params: SecondaryActionParams) -> Result<Value, ToolError> {
        windows::activate_window(params.window_id)?;
        let element = self.element(params.window_id, params.element_index)?;
        uia::secondary_action(&element, &params.action)?;
        Ok(json!({ "completed": true, "action": params.action }))
    }

    fn element(&self, window_id: u64, index: u32) -> Result<UIElement, ToolError> {
        let snapshot = self.snapshots.get(&window_id).ok_or_else(|| {
            ToolError::new(
                "no_snapshot",
                "Call computer_get_window_state with includeText=true before using elementIndex.",
            )
        })?;
        snapshot
            .elements
            .get(index as usize)
            .cloned()
            .ok_or_else(|| {
                ToolError::new(
                    "invalid_element_index",
                    format!("Element index {index} is not part of the latest observation."),
                )
            })
    }

    fn capture_mapping(&self, window_id: u64) -> Result<&CaptureMapping, ToolError> {
        self.captures.get(&window_id).ok_or_else(|| {
            ToolError::new(
                "no_screenshot",
                "Take a screenshot with computer_get_window_state before using coordinates.",
            )
        })
    }
}

fn parse<T>(params: Value) -> Result<T, ToolError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(params).map_err(|error| ToolError::invalid(error.to_string()))
}

fn default_true() -> bool {
    true
}

fn window_json(window: &windows::WindowInfo) -> Value {
    json!({
        "id": window.id,
        "app": window.app,
        "displayName": window.display_name,
        "title": window.title,
        "isForeground": window.is_foreground,
    })
}

fn map_point(mapping: &CaptureMapping, x: f64, y: f64) -> (i32, i32) {
    (
        (mapping.origin_x as f64 + x * mapping.scale_x).round() as i32,
        (mapping.origin_y as f64 + y * mapping.scale_y).round() as i32,
    )
}

fn normalized_button(button: Option<&str>) -> String {
    match button.unwrap_or("left").to_ascii_lowercase().as_str() {
        "right" | "r" => "right".to_string(),
        "middle" | "m" => "middle".to_string(),
        _ => "left".to_string(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchParams {
    app: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowParams {
    window_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetWindowStateParams {
    window_id: u64,
    #[serde(default = "default_true")]
    include_screenshot: bool,
    #[serde(default)]
    include_text: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickParams {
    window_id: u64,
    element_index: Option<u32>,
    x: Option<f64>,
    y: Option<f64>,
    mouse_button: Option<String>,
    click_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeTextParams {
    window_id: u64,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PressKeyParams {
    window_id: u64,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollParams {
    window_id: u64,
    x: Option<f64>,
    y: Option<f64>,
    scroll_x: i32,
    scroll_y: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetValueParams {
    window_id: u64,
    element_index: u32,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DragParams {
    window_id: u64,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecondaryActionParams {
    window_id: u64,
    element_index: u32,
    action: String,
}
