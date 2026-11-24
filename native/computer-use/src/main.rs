mod protocol;

#[cfg(windows)]
mod win;

#[cfg(not(windows))]
mod unsupported;

use std::io::{self, BufRead, Write};

use protocol::{Request, error_response, ok_response};

#[cfg(windows)]
use win::ComputerUse;

#[cfg(not(windows))]
use unsupported::ComputerUse;

fn main() {
    #[cfg(windows)]
    win::init_process();

    let mut dispatcher = ComputerUse::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let response = error_response(
                    0,
                    &protocol::ToolError::new("invalid_request", error.to_string()),
                );
                let _ = writeln!(stdout, "{response}");
                let _ = stdout.flush();
                continue;
            }
        };
        let response = match dispatcher.dispatch(&request.method, request.params) {
            Ok(result) => ok_response(request.id, result),
            Err(error) => error_response(request.id, &error),
        };
        let _ = writeln!(stdout, "{response}");
        let _ = stdout.flush();
    }
}
