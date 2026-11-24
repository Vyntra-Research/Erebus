// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Computer Use owns a long-lived NDJSON child process with per-request deadlines.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 20_000;
const BINARY_NAME =
  process.platform === "win32" ? "erebus-computer-use.exe" : "erebus-computer-use";

export class ComputerUseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ComputerUseError";
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

let configuredBinaryPath: string | undefined;

export function setComputerUseBinaryPath(binaryPath: string | undefined): void {
  if (binaryPath) configuredBinaryPath = binaryPath;
}

function resolveBinaryPath(): string | undefined {
  const candidates: string[] = [];
  if (configuredBinaryPath) candidates.push(configuredBinaryPath);
  const configured = process.env.EREBUS_COMPUTER_USE_PATH;
  if (configured) candidates.push(configured);

  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(
      path.join(directory, "native", "computer-use", "target", "release", BINARY_NAME),
      path.join(directory, "native", "computer-use", "target", "debug", BINARY_NAME),
      path.join(directory, "computer-use", BINARY_NAME),
    );
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "computer-use", BINARY_NAME));
  }
  candidates.push(
    path.join(path.dirname(process.execPath), "resources", "computer-use", BINARY_NAME),
  );

  return candidates.find((candidate) => existsSync(candidate));
}

class ComputerUseRuntime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private tail: Promise<unknown> = Promise.resolve();
  private lastStderr = "";

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const run = () => this.send(method, params, timeoutMs);
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  shutdown(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill();
    }
    this.failAll(new ComputerUseError("shutdown", "Computer Use runtime was shut down."));
  }

  private send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId;
    this.nextId += 1;
    const payload = `${JSON.stringify({ id, method, params: params ?? {} })}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ComputerUseError(
            "timeout",
            `Computer Use request '${method}' did not finish in ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ComputerUseError("write_failed", error.message));
      });
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    const binary = resolveBinaryPath();
    if (!binary) {
      throw new ComputerUseError(
        "unavailable",
        "Computer Use runtime was not found. Build native/computer-use or set EREBUS_COMPUTER_USE_PATH.",
      );
    }

    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.lastStderr = `${this.lastStderr}${chunk}`.slice(-2000);
    });
    child.on("error", (error) => {
      this.failAll(new ComputerUseError("spawn_failed", error.message));
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      const detail = this.lastStderr.trim();
      this.failAll(
        new ComputerUseError(
          "runtime_exited",
          `Computer Use runtime exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    this.child = child;
    return child;
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;

      let parsed: {
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: { code?: string; message?: string };
      };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (typeof parsed.id !== "number") continue;
      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.ok === true) {
        pending.resolve(parsed.result);
      } else {
        pending.reject(
          new ComputerUseError(
            parsed.error?.code ?? "runtime_error",
            parsed.error?.message ?? "Computer Use request failed.",
          ),
        );
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const computerUseRuntime = new ComputerUseRuntime();

process.once("exit", () => {
  computerUseRuntime.shutdown();
});

export function requestComputerUse<T = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number,
): Promise<T> {
  return computerUseRuntime.request(method, params, timeoutMs) as Promise<T>;
}
