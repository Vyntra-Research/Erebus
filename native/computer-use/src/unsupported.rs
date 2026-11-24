use serde_json::Value;

use crate::protocol::ToolError;

pub struct ComputerUse;

impl ComputerUse {
    pub fn new() -> Self {
        Self
    }

    pub fn dispatch(&mut self, _method: &str, _params: Value) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(
            "Computer Use is implemented for Windows only. This build has no desktop backend.",
        ))
    }
}
