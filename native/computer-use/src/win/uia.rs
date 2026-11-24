use uiautomation::core::UIAutomation;
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UIScrollPattern, UISelectionItemPattern,
    UITextPattern, UITogglePattern, UIValuePattern,
};
use uiautomation::types::{ControlType, Handle, ScrollAmount};
use uiautomation::{UIElement, UITreeWalker};

use crate::protocol::ToolError;
use crate::win::input;

const MAX_NODES: usize = 1500;
const MAX_DEPTH: usize = 40;

pub struct TreeResult {
    pub text: String,
    pub elements: Vec<UIElement>,
    pub focused_element: Option<String>,
    pub document_text: Option<String>,
}

pub fn capture_tree(automation: &UIAutomation, window_id: u64) -> Result<TreeResult, ToolError> {
    let root = automation
        .element_from_handle(Handle::from(window_id as isize))
        .map_err(uia_error)?;
    let walker = automation.get_control_view_walker().map_err(uia_error)?;
    let mut elements = Vec::new();
    let mut text = String::new();
    let mut document_text = None;
    walk(
        &walker,
        &root,
        0,
        &mut elements,
        &mut text,
        &mut document_text,
    );
    let focused_element = automation
        .get_focused_element()
        .ok()
        .map(|element| describe(&element));
    Ok(TreeResult {
        text,
        elements,
        focused_element,
        document_text,
    })
}

fn walk(
    walker: &UITreeWalker,
    element: &UIElement,
    depth: usize,
    elements: &mut Vec<UIElement>,
    text: &mut String,
    document_text: &mut Option<String>,
) {
    if elements.len() >= MAX_NODES {
        return;
    }
    let index = elements.len();
    elements.push(element.clone());
    text.push_str(&"  ".repeat(depth));
    text.push('[');
    text.push_str(&index.to_string());
    text.push_str("] ");
    text.push_str(&describe(element));
    text.push('\n');

    if document_text.is_none()
        && matches!(
            element.get_control_type().ok(),
            Some(ControlType::Document | ControlType::Edit)
        )
        && let Ok(pattern) = element.get_pattern::<UITextPattern>()
        && let Ok(range) = pattern.get_document_range()
        && let Ok(value) = range.get_text(20_000)
        && !value.is_empty()
    {
        *document_text = Some(value);
    }

    if depth >= MAX_DEPTH {
        return;
    }
    let mut child = match walker.get_first_child(element) {
        Ok(child) => child,
        Err(_) => return,
    };
    loop {
        walk(walker, &child, depth + 1, elements, text, document_text);
        if elements.len() >= MAX_NODES {
            break;
        }
        match walker.get_next_sibling(&child) {
            Ok(next) => child = next,
            Err(_) => break,
        }
    }
}

fn describe(element: &UIElement) -> String {
    let control_type = element
        .get_localized_control_type()
        .map(|value| value.to_lowercase())
        .unwrap_or_else(|_| {
            format!(
                "{:?}",
                element.get_control_type().unwrap_or(ControlType::Custom)
            )
            .to_lowercase()
        });
    let is_text_document = matches!(
        element.get_control_type().ok(),
        Some(ControlType::Document | ControlType::Edit)
    );
    let name = element.get_name().unwrap_or_default();
    let mut line = format!("{control_type} \"{}\"", truncate(&sanitize(&name), 160));

    if !element.is_password().unwrap_or(false)
        && let Ok(value) = element
            .get_pattern::<UIValuePattern>()
            .and_then(|pattern| pattern.get_value())
        && !value.is_empty()
    {
        let label = if is_text_document {
            "valueNormalized"
        } else {
            "value"
        };
        line.push_str(&format!(
            " {label}=\"{}\"",
            truncate(&sanitize(&value), 160)
        ));
    }

    if element.is_enabled() == Ok(false) {
        line.push_str(" disabled");
    }
    if element.is_offscreen() == Ok(true) {
        line.push_str(" offscreen");
    }
    if element.has_keyboard_focus() == Ok(true) {
        line.push_str(" focused");
    }
    if let Ok(rect) = element.get_bounding_rectangle() {
        line.push_str(&format!(
            " bounds=({},{},{},{})",
            rect.get_left(),
            rect.get_top(),
            rect.get_right() - rect.get_left(),
            rect.get_bottom() - rect.get_top()
        ));
    }
    line
}

fn sanitize(value: &str) -> String {
    value.replace(['\r', '\n', '\t'], " ").replace('"', "'")
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push('…');
    truncated
}

pub fn click_element(element: &UIElement, button: &str, count: u32) -> Result<(), ToolError> {
    let (x, y) = element_point(element)?;
    input::click_at(x, y, button, count);
    Ok(())
}

pub fn element_point(element: &UIElement) -> Result<(i32, i32), ToolError> {
    if let Ok(Some(point)) = element.get_clickable_point() {
        return Ok((point.get_x(), point.get_y()));
    }
    let rect = element.get_bounding_rectangle().map_err(uia_error)?;
    Ok((
        (rect.get_left() + rect.get_right()) / 2,
        (rect.get_top() + rect.get_bottom()) / 2,
    ))
}

pub fn set_value(element: &UIElement, value: &str) -> Result<(), ToolError> {
    let pattern = element.get_pattern::<UIValuePattern>().map_err(|_| {
        ToolError::new(
            "unsupported_action",
            "The element has no value pattern. Click it and type instead.",
        )
    })?;
    pattern.set_value(value).map_err(uia_error)
}

pub fn secondary_action(element: &UIElement, action: &str) -> Result<(), ToolError> {
    let normalized = action.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "invoke" | "press" | "click" | "default" => element
            .get_pattern::<UIInvokePattern>()
            .and_then(|pattern| pattern.invoke())
            .map_err(uia_error),
        "toggle" => element
            .get_pattern::<UITogglePattern>()
            .and_then(|pattern| pattern.toggle())
            .map_err(uia_error),
        "expand" => element
            .get_pattern::<UIExpandCollapsePattern>()
            .and_then(|pattern| pattern.expand())
            .map_err(uia_error),
        "collapse" => element
            .get_pattern::<UIExpandCollapsePattern>()
            .and_then(|pattern| pattern.collapse())
            .map_err(uia_error),
        "select" => element
            .get_pattern::<UISelectionItemPattern>()
            .and_then(|pattern| pattern.select())
            .map_err(uia_error),
        "focus" => element.set_focus().map_err(uia_error),
        "scroll up" | "scroll_up" => scroll_pattern(
            element,
            ScrollAmount::NoAmount,
            ScrollAmount::LargeDecrement,
        ),
        "scroll down" | "scroll_down" => scroll_pattern(
            element,
            ScrollAmount::NoAmount,
            ScrollAmount::LargeIncrement,
        ),
        "scroll left" | "scroll_left" => scroll_pattern(
            element,
            ScrollAmount::LargeDecrement,
            ScrollAmount::NoAmount,
        ),
        "scroll right" | "scroll_right" => scroll_pattern(
            element,
            ScrollAmount::LargeIncrement,
            ScrollAmount::NoAmount,
        ),
        other => Err(ToolError::new(
            "unsupported_action",
            format!(
                "Unsupported secondary action '{other}'. Use invoke, toggle, expand, collapse, select, focus, or scroll up/down/left/right."
            ),
        )),
    }
}

fn scroll_pattern(
    element: &UIElement,
    horizontal: ScrollAmount,
    vertical: ScrollAmount,
) -> Result<(), ToolError> {
    element
        .get_pattern::<UIScrollPattern>()
        .and_then(|pattern| pattern.scroll(horizontal, vertical))
        .map_err(uia_error)
}

fn uia_error(error: uiautomation::Error) -> ToolError {
    ToolError::new("uia_error", error.to_string())
}
