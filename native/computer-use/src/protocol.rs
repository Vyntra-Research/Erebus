use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[allow(dead_code)]
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_params", message)
    }

    #[allow(dead_code)]
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
}

pub fn ok_response(id: u64, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result })
}

pub fn error_response(id: u64, error: &ToolError) -> Value {
    json!({
        "id": id,
        "ok": false,
        "error": { "code": error.code, "message": error.message }
    })
}
