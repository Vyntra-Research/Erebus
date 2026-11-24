use std::mem::size_of;
use std::thread;
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS, MOUSEINPUT,
    SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

use crate::protocol::ToolError;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_LSHIFT: u16 = 0xA0;
const VK_RSHIFT: u16 = 0xA1;
const VK_LCONTROL: u16 = 0xA2;
const VK_RCONTROL: u16 = 0xA3;
const VK_LMENU: u16 = 0xA4;
const VK_RMENU: u16 = 0xA5;
const VK_LWIN: u16 = 0x5B;

const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
const MOUSEEVENTF_WHEEL: u32 = 0x0800;
const MOUSEEVENTF_HWHEEL: u32 = 0x1000;

pub fn click_at(x: i32, y: i32, button: &str, count: u32) {
    let _ = unsafe { SetCursorPos(x, y) };
    thread::sleep(Duration::from_millis(20));
    let (down, up) = match button {
        "right" | "r" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" | "m" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };
    for index in 0..count.max(1) {
        mouse_event(down, 0);
        thread::sleep(Duration::from_millis(30));
        mouse_event(up, 0);
        if index + 1 < count {
            thread::sleep(Duration::from_millis(60));
        }
    }
}

pub fn scroll_at(x: i32, y: i32, scroll_x: i32, scroll_y: i32) {
    let _ = unsafe { SetCursorPos(x, y) };
    thread::sleep(Duration::from_millis(20));
    if scroll_y != 0 {
        mouse_event(MOUSEEVENTF_WHEEL, -scroll_y * 120);
    }
    if scroll_x != 0 {
        mouse_event(MOUSEEVENTF_HWHEEL, scroll_x * 120);
    }
}

pub fn drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) {
    let _ = unsafe { SetCursorPos(from_x, from_y) };
    thread::sleep(Duration::from_millis(30));
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0);
    thread::sleep(Duration::from_millis(40));
    let steps = 16;
    for step in 1..=steps {
        let x = from_x + (to_x - from_x) * step / steps;
        let y = from_y + (to_y - from_y) * step / steps;
        let _ = unsafe { SetCursorPos(x, y) };
        thread::sleep(Duration::from_millis(12));
    }
    thread::sleep(Duration::from_millis(40));
    mouse_event(MOUSEEVENTF_LEFTUP, 0);
}

pub fn type_text(text: &str) {
    let normalized = text.replace("\r\n", "\n").replace('\r', "");
    let mut inputs: Vec<INPUT> = Vec::new();
    for unit in normalized.encode_utf16().take(20_000) {
        match unit {
            0x0A => {
                inputs.push(key_input(0x0D, false, false));
                inputs.push(key_input(0x0D, true, false));
            }
            0x09 => {
                inputs.push(key_input(0x09, false, false));
                inputs.push(key_input(0x09, true, false));
            }
            _ => {
                inputs.push(unicode_input(unit, false));
                inputs.push(unicode_input(unit, true));
            }
        }
        if inputs.len() >= 128 {
            send_inputs(&inputs);
            inputs.clear();
            thread::sleep(Duration::from_millis(2));
        }
    }
    if !inputs.is_empty() {
        send_inputs(&inputs);
    }
}

pub fn press_chord(chord: &str) -> Result<(), ToolError> {
    let tokens: Vec<&str> = chord
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();
    let Some((key, modifiers)) = tokens.split_last() else {
        return Err(ToolError::invalid("A key chord is required."));
    };

    let mut modifier_vks = Vec::new();
    for modifier in modifiers {
        modifier_vks.push(modifier_vk(modifier)?);
    }

    let (key_vk, extended, needs_shift) = key_vk(key)?;
    if needs_shift && !modifier_vks.contains(&VK_SHIFT) {
        modifier_vks.push(VK_SHIFT);
    }

    for modifier in &modifier_vks {
        key_event(*modifier, false, false);
        thread::sleep(Duration::from_millis(10));
    }
    key_event(key_vk, false, extended);
    thread::sleep(Duration::from_millis(25));
    key_event(key_vk, true, extended);
    for modifier in modifier_vks.iter().rev() {
        thread::sleep(Duration::from_millis(10));
        key_event(*modifier, true, false);
    }
    Ok(())
}

fn modifier_vk(name: &str) -> Result<u16, ToolError> {
    match normalize(name).as_str() {
        "control" | "ctrl" => Ok(VK_CONTROL),
        "shift" => Ok(VK_SHIFT),
        "alt" | "option" | "opt" | "menu" => Ok(VK_MENU),
        "win" | "super" | "meta" | "command" | "cmd" => Ok(VK_LWIN),
        "control_l" | "ctrl_l" | "leftcontrol" | "leftctrl" => Ok(VK_LCONTROL),
        "control_r" | "ctrl_r" | "rightcontrol" | "rightctrl" => Ok(VK_RCONTROL),
        "shift_l" | "leftshift" => Ok(VK_LSHIFT),
        "shift_r" | "rightshift" => Ok(VK_RSHIFT),
        "alt_l" | "leftalt" => Ok(VK_LMENU),
        "alt_r" | "rightalt" => Ok(VK_RMENU),
        other => Err(ToolError::invalid(format!(
            "Unknown modifier '{other}' in the key chord."
        ))),
    }
}

fn key_vk(name: &str) -> Result<(u16, bool, bool), ToolError> {
    if name.chars().count() == 1 {
        let character = name.chars().next().unwrap_or(' ');
        if character.is_ascii_alphabetic() {
            return Ok((
                character.to_ascii_uppercase() as u16,
                false,
                character.is_ascii_uppercase(),
            ));
        }
        if character.is_ascii_digit() {
            return Ok((character as u16, false, false));
        }
        return match character {
            ' ' => Ok((0x20, false, false)),
            '=' => Ok((0xBB, false, false)),
            '+' => Ok((0xBB, false, true)),
            '-' => Ok((0xBD, false, false)),
            '_' => Ok((0xBD, false, true)),
            ',' => Ok((0xBC, false, false)),
            '.' => Ok((0xBE, false, false)),
            '/' => Ok((0xBF, false, false)),
            '\\' => Ok((0xDC, false, false)),
            ';' => Ok((0xBA, false, false)),
            ':' => Ok((0xBA, false, true)),
            '\'' => Ok((0xDE, false, false)),
            '"' => Ok((0xDE, false, true)),
            '[' => Ok((0xDB, false, false)),
            ']' => Ok((0xDD, false, false)),
            '`' => Ok((0xC0, false, false)),
            '~' => Ok((0xC0, false, true)),
            '!' => Ok((0x31, false, true)),
            '@' => Ok((0x32, false, true)),
            '#' => Ok((0x33, false, true)),
            '$' => Ok((0x34, false, true)),
            '%' => Ok((0x35, false, true)),
            '^' => Ok((0x36, false, true)),
            '&' => Ok((0x37, false, true)),
            '*' => Ok((0x38, false, true)),
            '(' => Ok((0x39, false, true)),
            ')' => Ok((0x30, false, true)),
            '<' => Ok((0xBC, false, true)),
            '>' => Ok((0xBE, false, true)),
            '?' => Ok((0xBF, false, true)),
            '{' => Ok((0xDB, false, true)),
            '}' => Ok((0xDD, false, true)),
            '|' => Ok((0xDC, false, true)),
            other => Err(ToolError::invalid(format!("Unsupported key '{other}'."))),
        };
    }

    let normalized = normalize(name);
    let simple = match normalized.as_str() {
        "space" => Some(0x20),
        "return" | "enter" => Some(0x0D),
        "tab" => Some(0x09),
        "escape" | "esc" => Some(0x1B),
        "backspace" | "back_space" => Some(0x08),
        "delete" | "del" => Some(0x2E),
        "insert" | "ins" => Some(0x2D),
        "home" => Some(0x24),
        "end" => Some(0x23),
        "pageup" | "page_up" | "prior" => Some(0x21),
        "pagedown" | "page_down" | "next" => Some(0x22),
        "up" | "arrowup" | "arrow_up" => Some(0x26),
        "down" | "arrowdown" | "arrow_down" => Some(0x28),
        "left" | "arrowleft" | "arrow_left" => Some(0x25),
        "right" | "arrowright" | "arrow_right" => Some(0x27),
        "print" | "printscreen" | "print_screen" => Some(0x2C),
        "pause" => Some(0x13),
        "capslock" | "caps_lock" => Some(0x14),
        "numlock" | "num_lock" => Some(0x90),
        "scrolllock" | "scroll_lock" => Some(0x91),
        "apps" | "contextmenu" | "context_menu" => Some(0x5D),
        "period" | "dot" => Some(0xBE),
        "comma" => Some(0xBC),
        "slash" => Some(0xBF),
        "backslash" => Some(0xDC),
        "semicolon" => Some(0xBA),
        "apostrophe" | "quote" => Some(0xDE),
        "bracketleft" | "leftbracket" | "left_bracket" => Some(0xDB),
        "bracketright" | "rightbracket" | "right_bracket" => Some(0xDD),
        "minus" => Some(0xBD),
        "equal" => Some(0xBB),
        "grave" | "backtick" => Some(0xC0),
        "numpad_enter" => Some(0x0D),
        "numpad_add" | "kp_add" => Some(0x6B),
        "numpad_subtract" | "kp_subtract" => Some(0x6D),
        "numpad_multiply" | "kp_multiply" => Some(0x6A),
        "numpad_divide" | "kp_divide" => Some(0x6F),
        "numpad_decimal" | "kp_decimal" => Some(0x6E),
        _ => None,
    };
    if let Some(vk) = simple {
        return Ok((vk, is_extended(vk), false));
    }

    if let Some(rest) = normalized.strip_prefix('f')
        && let Ok(number) = rest.parse::<u16>()
        && (1..=24).contains(&number)
    {
        return Ok((0x70 + number - 1, false, false));
    }

    for (prefix, base) in [("numpad_", 0x60u16), ("kp_", 0x60u16), ("num", 0x60u16)] {
        if let Some(rest) = normalized.strip_prefix(prefix)
            && let Ok(number) = rest.parse::<u16>()
            && number <= 9
        {
            return Ok((base + number, false, false));
        }
    }

    let shifted = match normalized.as_str() {
        "plus" => Some(0xBB),
        "underscore" => Some(0xBD),
        "colon" => Some(0xBA),
        "quotedbl" => Some(0xDE),
        "question" => Some(0xBF),
        "bar" => Some(0xDC),
        "less" => Some(0xBC),
        "greater" => Some(0xBE),
        "tilde" => Some(0xC0),
        "exclam" => Some(0x31),
        "at" => Some(0x32),
        "numbersign" => Some(0x33),
        "dollar" => Some(0x34),
        "percent" => Some(0x35),
        "asciicircum" => Some(0x36),
        "ampersand" => Some(0x37),
        "asterisk" => Some(0x38),
        "parenleft" => Some(0x39),
        "parenright" => Some(0x30),
        "braceleft" => Some(0xDB),
        "braceright" => Some(0xDD),
        _ => None,
    };
    if let Some(vk) = shifted {
        return Ok((vk, is_extended(vk), true));
    }

    Err(ToolError::invalid(format!("Unknown key '{name}'.")))
}

fn is_extended(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90
    )
}

fn normalize(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn key_event(vk: u16, up: bool, extended: bool) {
    let mut bits: u32 = 0;
    if up {
        bits |= KEYEVENTF_KEYUP.0;
    }
    if extended {
        bits |= KEYEVENTF_EXTENDEDKEY.0;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(bits),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_inputs(&[input]);
}

fn key_input(vk: u16, up: bool, extended: bool) -> INPUT {
    let mut bits: u32 = 0;
    if up {
        bits |= KEYEVENTF_KEYUP.0;
    }
    if extended {
        bits |= KEYEVENTF_EXTENDEDKEY.0;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(bits),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    let mut bits = KEYEVENTF_UNICODE.0;
    if up {
        bits |= KEYEVENTF_KEYUP.0;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: KEYBD_EVENT_FLAGS(bits),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn mouse_event(flags: u32, data: i32) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data as u32,
                dwFlags: MOUSE_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_inputs(&[input]);
}

fn send_inputs(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, size_of::<INPUT>() as i32);
    }
}
