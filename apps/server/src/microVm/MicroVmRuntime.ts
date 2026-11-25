// @effect-diagnostics nodeBuiltinImport:off - Microsandbox uses a host-local runtime and paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  MicroVmError,
  type MicroVmControlInput,
  type MicroVmCreateInput,
  type MicroVmDesktop,
  type MicroVmInfo,
  type MicroVmModifyInput,
  type MicroVmPort,
  type MicroVmPortInput,
  type MicroVmRemoveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Microsandbox from "microsandbox";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { DESKTOP_AGENT_GUEST_PORT, DESKTOP_AGENT_SOURCE } from "./desktopAgentSource.ts";

type MicrosandboxModule = typeof import("microsandbox");

const PORTS_LABEL = "erebus.ports";
const DESKTOP_LABEL = "erebus.desktop";
const DESKTOP_SCRIPT = "erebus-desktop";
const DESKTOP_GUEST_PORT = 6080;
const DEFAULT_DESKTOP_WIDTH = 1440;
const DEFAULT_DESKTOP_HEIGHT = 900;
const DEFAULT_DESKTOP_IMAGE = "debian:bookworm-slim";

/**
 * Sandbox handles that keep a local VM resident. Microsandbox's explicit
 * detached mode is broken on the Windows preview (the background boot exits
 * with access denied), but an attached handle stays alive while it is
 * referenced. The server owns this process for the lifetime of the app, so a
 * module-level registry preserves the handle across per-tool runtime
 * instances.
 */
const liveSandboxes = new Map<string, Microsandbox.Sandbox>();

const liveSandboxKey = (home: string, name: string): string => `${home}\0${name}`;

export function resolveMicrosandboxBinaryPaths(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly resourcesPath?: string | undefined;
  readonly moduleDirectory: string;
}): { readonly msbPath: string; readonly libkrunfwPath: string } | null {
  if (input.platform !== "win32") return null;
  const packageName =
    input.arch === "arm64" ? "microsandbox-win32-arm64-msvc" : "microsandbox-win32-x64-msvc";
  const roots: string[] = [];
  if (input.resourcesPath !== undefined && input.resourcesPath.length > 0) {
    roots.push(NodePath.join(input.resourcesPath, "server.asar.unpacked", "node_modules"));
  }
  const unpackedModuleDirectory = input.moduleDirectory.replace(
    `${NodePath.sep}server.asar${NodePath.sep}`,
    `${NodePath.sep}server.asar.unpacked${NodePath.sep}`,
  );
  roots.push(NodePath.resolve(unpackedModuleDirectory, "../../..", "node_modules"));

  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const packageDirectory = NodePath.join(root, "@superradcompany", packageName);
    const msbPath = NodePath.join(packageDirectory, "bin", "msb.exe");
    const libkrunfwPath = NodePath.join(packageDirectory, "lib", "libkrunfw.dll");
    if (NodeFS.existsSync(msbPath) && NodeFS.existsSync(libkrunfwPath)) {
      return { msbPath, libkrunfwPath };
    }
  }
  return null;
}

const portNumber = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return value;
};

const normalizePort = (input: MicroVmPortInput): MicroVmPort => {
  const hostBind = input.hostBind?.trim() || "127.0.0.1";
  if (hostBind !== "127.0.0.1" && hostBind !== "::1" && hostBind !== "localhost") {
    throw new Error("hostBind must be a loopback address.");
  }
  return {
    hostPort: portNumber(input.hostPort, "hostPort"),
    guestPort: portNumber(input.guestPort, "guestPort"),
    hostBind,
    protocol: input.protocol ?? "tcp",
  };
};

const portKey = (port: {
  readonly hostBind: string;
  readonly hostPort: number;
  readonly protocol: "tcp" | "udp";
}): string => `${port.hostBind}\u0000${port.hostPort}\u0000${port.protocol}`;

const validatePorts = (ports: ReadonlyArray<MicroVmPort>): ReadonlyArray<MicroVmPort> => {
  const seen = new Set<string>();
  for (const port of ports) {
    const key = portKey(port);
    if (seen.has(key)) {
      throw new Error(
        `Host endpoint ${port.hostBind}:${port.hostPort}/${port.protocol} is published more than once.`,
      );
    }
    seen.add(key);
  }
  return ports;
};

const parseJsonRecord = (value: string | undefined): Record<string, unknown> | null => {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const parsePortsLabel = (value: string | undefined): ReadonlyArray<MicroVmPort> => {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.hostPort !== "number" ||
        typeof record.guestPort !== "number" ||
        (record.protocol !== "tcp" && record.protocol !== "udp")
      ) {
        return [];
      }
      return [
        {
          hostPort: record.hostPort,
          guestPort: record.guestPort,
          hostBind: typeof record.hostBind === "string" ? record.hostBind : "127.0.0.1",
          protocol: record.protocol,
        },
      ];
    });
  } catch {
    return [];
  }
};

interface DesktopLabelState {
  readonly desktop: MicroVmDesktop;
  readonly agentToken: string | null;
}

const parseDesktopLabel = (value: string | undefined): DesktopLabelState | null => {
  const record = parseJsonRecord(value);
  if (record === null) return null;
  const hostPort = record.hostPort;
  const guestPort = record.guestPort;
  const width = record.width;
  const height = record.height;
  const agentPort = record.agentPort;
  if (
    typeof hostPort !== "number" ||
    typeof guestPort !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    (agentPort !== undefined && typeof agentPort !== "number")
  ) {
    return null;
  }
  return {
    desktop: {
      hostPort,
      guestPort,
      width,
      height,
      ...(typeof agentPort === "number" ? { agentPort } : {}),
      viewerUrl: `http://127.0.0.1:${hostPort}/vnc.html?autoconnect=1&resize=scale`,
    },
    agentToken: typeof record.agentToken === "string" ? record.agentToken : null,
  };
};

const desktopScript = (width: number, height: number): string => `#!/bin/sh
set -eu
if [ -f /run/erebus-desktop.pid ] && kill -0 "$(cat /run/erebus-desktop.pid)" 2>/dev/null; then
  exit 0
fi
rm -f /run/erebus-desktop.pid
mkdir -p /run
echo $$ > /run/erebus-desktop.pid
if [ ! -f /var/lib/erebus-desktop-ready ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  install_desktop() {
    apt-get install -y --no-install-recommends \\
      breeze-icon-theme ca-certificates dbus-x11 lxqt-core novnc openbox \\
      qterminal tigervnc-standalone-server websockify chromium xdotool xdg-utils \\
      scrot wmctrl python3
  }
  if ! install_desktop; then
    dpkg --configure -a || true
    install_desktop
  fi
  if [ ! -s /usr/bin/Xtigervnc ] || [ ! -s /usr/bin/websockify ] || [ ! -s /usr/bin/chromium ]; then
    apt-get install --reinstall -y tigervnc-standalone-server websockify chromium
  fi
  rm -rf /var/lib/apt/lists/*
  mkdir -p /etc/chromium.d
  cat > /etc/chromium.d/erebus <<'CHROMIUM'
CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage"
CHROMIUM
  touch /var/lib/erebus-desktop-ready
fi
mkdir -p /root/.config/lxqt /root/.config/openbox /tmp/runtime-root
chmod 700 /tmp/runtime-root
sed -e "s/,quicklaunch//" -e "/^\\[quicklaunch\\]/,/^$/d" \\
  /usr/share/lxqt/panel.conf > /root/.config/lxqt/panel.conf
sed "s#<name>Clearlooks</name>#<name>Breeze-ob</name>#" \\
  /etc/xdg/openbox/rc.xml > /root/.config/openbox/rc.xml
mkdir -p /tmp/.X11-unix
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xtigervnc :1 -SecurityTypes None -geometry ${width}x${height} -depth 24 >/tmp/xvnc.log 2>&1 &
vnc_pid=$!
sleep 2
if ! kill -0 "$vnc_pid"; then
  cat /tmp/xvnc.log >&2
  exit 1
fi
DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/runtime-root \\
  dbus-launch --exit-with-session sh -c "
    startlxqt &
    session_pid=\\$!
    sleep 4
    kill -0 \\"\\$session_pid\\"
    qterminal &
    wait \\"\\$session_pid\\"
  " >/tmp/lxqt.log 2>&1 &
desktop_pid=$!
sleep 5
if ! kill -0 "$desktop_pid"; then
  cat /tmp/lxqt.log >&2
  exit 1
fi
DISPLAY=:1 nohup python3 /usr/local/bin/erebus-desktop-agent >/tmp/erebus-agent.log 2>&1 &
exec websockify --web=/usr/share/novnc 0.0.0.0:${DESKTOP_GUEST_PORT} localhost:5901
`;

const allocateHostPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not allocate a host port for the desktop."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const findAvailableHostPort = async (
  excluded: ReadonlySet<number> = new Set<number>(),
): Promise<number> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await allocateHostPort();
    if (!excluded.has(port)) return port;
  }
  throw new Error("Could not allocate a distinct host port for the desktop.");
};

export function buildMicroVmModifyOptions(
  current: MicroVmInfo,
  input: MicroVmModifyInput,
): Microsandbox.ModifyOptions | null {
  const cpus = input.cpus === undefined ? current.cpus : positiveInt(input.cpus, 0, "cpus");
  const memory =
    input.memoryMiB === undefined
      ? current.memoryMiB
      : positiveInt(input.memoryMiB, 0, "memoryMiB");
  const maxCpus =
    input.maxCpus === undefined ? current.maxCpus : positiveInt(input.maxCpus, 0, "maxCpus");
  const maxMemory =
    input.maxMemoryMiB === undefined
      ? current.maxMemoryMiB
      : positiveInt(input.maxMemoryMiB, 0, "maxMemoryMiB");

  if (cpus > maxCpus) {
    throw new Error(`cpus (${cpus}) cannot exceed maxCpus (${maxCpus}).`);
  }
  if (memory > maxMemory) {
    throw new Error(`memoryMiB (${memory}) cannot exceed maxMemoryMiB (${maxMemory}).`);
  }
  if (
    input.rootDiskMiB !== undefined &&
    current.rootDiskMiB !== null &&
    input.rootDiskMiB < current.rootDiskMiB
  ) {
    throw new Error(
      `rootDiskMiB cannot shrink from ${current.rootDiskMiB} to ${input.rootDiskMiB}; only growth is supported.`,
    );
  }

  const addPorts = input.ports?.map(normalizePort) ?? [];
  const removePorts = input.portsRemove ?? [];
  const removedEndpoints = new Set(
    removePorts.map((port) => `${port.hostPort}\u0000${port.protocol ?? "tcp"}`),
  );
  if (current.desktop !== null) {
    const desktopEndpoint = `${current.desktop.hostPort}\u0000tcp`;
    if (removedEndpoints.has(desktopEndpoint)) {
      throw new Error("The desktop viewer port cannot be removed while the desktop is enabled.");
    }
    const desktopReplacement = addPorts.find(
      (port) => port.hostPort === current.desktop?.hostPort && port.protocol === "tcp",
    );
    if (
      desktopReplacement !== undefined &&
      desktopReplacement.guestPort !== current.desktop.guestPort
    ) {
      throw new Error(
        "The desktop viewer host port cannot be remapped to another guest port while the desktop is enabled.",
      );
    }
    if (current.desktop.agentPort !== undefined) {
      const agentEndpoint = `${current.desktop.agentPort}\u0000tcp`;
      if (removedEndpoints.has(agentEndpoint)) {
        throw new Error("The desktop agent port cannot be removed while the desktop is enabled.");
      }
      const agentReplacement = addPorts.find(
        (port) => port.hostPort === current.desktop?.agentPort && port.protocol === "tcp",
      );
      if (
        agentReplacement !== undefined &&
        agentReplacement.guestPort !== DESKTOP_AGENT_GUEST_PORT
      ) {
        throw new Error(
          "The desktop agent host port cannot be remapped to another guest port while the desktop is enabled.",
        );
      }
    }
  }
  const nextPorts = current.ports.filter(
    (port) => !removedEndpoints.has(`${port.hostPort}\u0000${port.protocol}`),
  );
  for (const port of addPorts) {
    const existingIndex = nextPorts.findIndex((candidate) => portKey(candidate) === portKey(port));
    if (existingIndex >= 0) nextPorts[existingIndex] = port;
    else nextPorts.push(port);
  }
  validatePorts(nextPorts);
  const portsChanged = addPorts.length > 0 || removePorts.length > 0;

  const options: Microsandbox.ModifyOptions = {
    ...(input.cpus !== undefined && cpus !== current.cpus ? { cpus } : {}),
    ...(input.memoryMiB !== undefined && memory !== current.memoryMiB ? { memory } : {}),
    ...(input.maxCpus !== undefined && maxCpus !== current.maxCpus ? { maxCpus } : {}),
    ...(input.maxMemoryMiB !== undefined && maxMemory !== current.maxMemoryMiB
      ? { maxMemory }
      : {}),
    ...(input.rootDiskMiB !== undefined && input.rootDiskMiB !== current.rootDiskMiB
      ? { rootDiskSize: positiveInt(input.rootDiskMiB, 0, "rootDiskMiB") }
      : {}),
    ...(input.workdir !== undefined && input.workdir !== current.workdir
      ? { workdir: input.workdir }
      : {}),
    ...(input.env !== undefined ? { env: { ...input.env } } : {}),
    ...(addPorts.length > 0
      ? {
          ports: addPorts.map((port) => ({
            hostPort: port.hostPort,
            guestPort: port.guestPort,
            hostBind: port.hostBind,
            protocol: port.protocol,
          })),
        }
      : {}),
    ...(removePorts.length > 0
      ? {
          portsRemove: removePorts.map((port) => ({
            hostPort: port.hostPort,
            ...(port.hostBind === undefined ? {} : { hostBind: port.hostBind }),
            protocol: port.protocol ?? "tcp",
          })),
        }
      : {}),
    ...(portsChanged ? { labels: { [PORTS_LABEL]: JSON.stringify(nextPorts) } } : {}),
  };
  if (Object.keys(options).length === 0) return null;
  options.policy =
    input.apply === "restart"
      ? "restart"
      : input.apply === "next-start"
        ? "next_start"
        : "no_restart";
  return options;
}

const WINDOWS_GUI_SUBSYSTEM = 2;
const WINDOWS_CONSOLE_SUBSYSTEM = 3;
const PE_POINTER_OFFSET = 0x3c;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const OPTIONAL_HEADER_SUBSYSTEM_OFFSET = 68;

async function readPeSubsystem(filePath: string): Promise<{
  readonly offset: number;
  readonly subsystem: number;
}> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(PE_POINTER_OFFSET + 4);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("Microsandbox runtime is not a valid Windows executable.");
    }
    const peOffset = dosHeader.readUInt32LE(PE_POINTER_OFFSET);
    const optionalHeaderOffset = peOffset + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE;
    const header = Buffer.alloc(OPTIONAL_HEADER_SUBSYSTEM_OFFSET + 2);
    const headerRead = await handle.read(header, 0, header.length, optionalHeaderOffset);
    if (
      headerRead.bytesRead !== header.length ||
      (header.readUInt16LE(0) !== 0x10b && header.readUInt16LE(0) !== 0x20b)
    ) {
      throw new Error("Microsandbox runtime has an invalid PE optional header.");
    }
    return {
      offset: optionalHeaderOffset + OPTIONAL_HEADER_SUBSYSTEM_OFFSET,
      subsystem: header.readUInt16LE(OPTIONAL_HEADER_SUBSYSTEM_OFFSET),
    };
  } finally {
    await handle.close();
  }
}

export async function materializeWindowlessWindowsExecutable(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const [sourceStat, destinationStat] = await Promise.all([
    NodeFSP.stat(sourcePath),
    NodeFSP.stat(destinationPath).catch(() => null),
  ]);
  if (destinationStat === null || destinationStat.size !== sourceStat.size) {
    await NodeFSP.copyFile(sourcePath, destinationPath);
  }

  const executable = await readPeSubsystem(destinationPath).catch(async () => {
    await NodeFSP.copyFile(sourcePath, destinationPath);
    return readPeSubsystem(destinationPath);
  });
  if (executable.subsystem === WINDOWS_GUI_SUBSYSTEM) return;
  if (executable.subsystem !== WINDOWS_CONSOLE_SUBSYSTEM) {
    throw new Error(
      `Microsandbox runtime uses unsupported Windows subsystem ${executable.subsystem}.`,
    );
  }

  const handle = await NodeFSP.open(destinationPath, "r+");
  try {
    const value = Buffer.alloc(2);
    value.writeUInt16LE(WINDOWS_GUI_SUBSYSTEM);
    await handle.write(value, 0, value.length, executable.offset);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function configureWindowlessWindowsRuntime(
  sdk: MicrosandboxModule,
  home: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): Promise<void> {
  if (platform !== "win32") return;
  const packaged = resolveMicrosandboxBinaryPaths({
    platform,
    arch,
    resourcesPath: (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath,
    moduleDirectory: NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  });
  const runtime = await sdk.ensureRuntime(
    packaged === null
      ? { home }
      : { home, msbPath: packaged.msbPath, libkrunfwPath: packaged.libkrunfwPath },
  );
  const version = (await sdk.resolveRuntimeVersion(runtime.msbPath)) ?? "unknown";
  const runtimeDir = NodePath.join(home, "runtime");
  await NodeFSP.mkdir(runtimeDir, { recursive: true });
  const destination = NodePath.join(
    runtimeDir,
    `msb-${version.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}-windowless.exe`,
  );
  await materializeWindowlessWindowsExecutable(runtime.msbPath, destination);
  process.env.MSB_PATH = destination;
  process.env.MSB_LIBKRUNFW_PATH = runtime.libkrunfwPath;
}

export interface MicroVmExecInput {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface MicroVmExecResult {
  readonly detached: boolean;
  readonly jobId: string | null;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface MicroVmCopyInput {
  readonly name: string;
  readonly source: string;
  readonly destination: string;
}

const errorDetail = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return String(error);
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === code;

const removableWithoutForce = new Set<Microsandbox.SandboxStatus>([
  "created",
  "stopped",
  "crashed",
]);

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MicroVmError({ operation, detail: errorDetail(cause) }),
  });

const positiveInt = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
};

const vmName = (requested: string | undefined): string => {
  if (requested !== undefined) {
    const normalized = requested.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)) {
      throw new Error(
        "MicroVM names must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores.",
      );
    }
    return normalized;
  }
  return `erebus-${NodeCrypto.randomUUID().slice(0, 8)}`;
};

const configRecord = (config: Microsandbox.SandboxConfig): Record<string, unknown> =>
  config as Record<string, unknown>;

const nestedRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const configImage = (config: Microsandbox.SandboxConfig): string => {
  const image = nestedRecord(configRecord(config).image);
  const oci = nestedRecord(image.Oci);
  return typeof oci.reference === "string" ? oci.reference : "unknown";
};

const configLabels = (config: Microsandbox.SandboxConfig): Record<string, string> => {
  const labels = configRecord(config).labels;
  return typeof labels === "object" && labels !== null ? (labels as Record<string, string>) : {};
};

const toInfo = async (handle: Microsandbox.SandboxHandle): Promise<MicroVmInfo> => {
  const config = handle.config();
  const raw = configRecord(config);
  const resources = nestedRecord(raw.resources);
  const runtime = nestedRecord(raw.runtime);
  const labels = configLabels(config);
  const rootDisk = nestedRecord(nestedRecord(nestedRecord(raw.image).Oci).rootDisk);
  const storage = await handle.storageUsage().catch(() => null);
  const allocated = storage?.allocatedBytes ?? storage?.logicalBytes ?? null;
  return {
    id: handle.id,
    name: handle.name,
    status: handle.status,
    image: configImage(config),
    cpus: Number(resources.cpus ?? 0),
    memoryMiB: Number(resources.memoryMib ?? 0),
    maxCpus: Number(resources.maxCpus ?? resources.cpus ?? 0),
    maxMemoryMiB: Number(resources.maxMemoryMib ?? resources.memoryMib ?? 0),
    rootDiskMiB: typeof rootDisk.sizeMib === "number" ? rootDisk.sizeMib : null,
    workdir: typeof runtime.workdir === "string" ? runtime.workdir : "/workspace",
    ports: parsePortsLabel(labels[PORTS_LABEL]),
    desktop: parseDesktopLabel(labels[DESKTOP_LABEL])?.desktop ?? null,
    projectId: labels["erebus.projectId"] ?? null,
    threadId: labels["erebus.threadId"] ?? null,
    createdAt: handle.createdAt?.toISOString() ?? null,
    updatedAt: handle.updatedAt?.toISOString() ?? null,
    storageBytes: allocated === null ? null : Number(allocated),
  };
};

const truncate = (value: string, maxBytes: number): { value: string; truncated: boolean } => {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
};

const isConnectionRefused = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ECONNREFUSED";

const isConnectionReset = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ECONNRESET";

const requestDesktopAgent = (
  agent: { readonly port: number; readonly token: string },
  path: string,
  body?: unknown,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: agent.port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: {
          "X-Erebus-Token": agent.token,
          ...(payload === null
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }),
        },
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 500;
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `Desktop agent request failed (${statusCode}): ${text.trim().slice(0, 500)}`,
              ),
            );
            return;
          }
          try {
            resolve(text.length === 0 ? {} : JSON.parse(text));
          } catch {
            reject(new Error("Desktop agent returned invalid JSON."));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("Desktop agent request timed out.")));
    request.once("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });

export interface MicroVmDesktopAgent {
  readonly port: number;
  readonly token: string;
}

export interface MicroVmRuntimeService {
  readonly home: string;
  readonly list: () => Effect.Effect<ReadonlyArray<MicroVmInfo>, MicroVmError>;
  readonly get: (name: string) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly create: (input: MicroVmCreateInput) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly control: (input: MicroVmControlInput) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly modify: (input: MicroVmModifyInput) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly remove: (input: MicroVmRemoveInput) => Effect.Effect<void, MicroVmError>;
  readonly exec: (input: MicroVmExecInput) => Effect.Effect<MicroVmExecResult, MicroVmError>;
  readonly ensureDesktop: (name: string) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly desktopAgent: (name: string) => Effect.Effect<MicroVmDesktopAgent, MicroVmError>;
  readonly desktopAgentRequest: (
    name: string,
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, MicroVmError>;
  readonly jobs: (name: string) => Effect.Effect<Microsandbox.JobPage, MicroVmError>;
  readonly jobLogs: (
    name: string,
    jobId: string,
    tail?: number,
  ) => Effect.Effect<ReadonlyArray<Microsandbox.JobLogEntry>, MicroVmError>;
  readonly stopJob: (name: string, jobId: string) => Effect.Effect<void, MicroVmError>;
  readonly copyIn: (input: MicroVmCopyInput) => Effect.Effect<void, MicroVmError>;
  readonly copyOut: (input: MicroVmCopyInput) => Effect.Effect<void, MicroVmError>;
}

export const make = Effect.fn("MicroVmRuntime.make")(function* (stateDir: string) {
  const home = NodePath.join(stateDir, "microvms");
  yield* attempt("initialize", () => NodeFSP.mkdir(home, { recursive: true }));
  process.env.MSB_HOME = home;

  const sdk = yield* attempt("load", () => import("microsandbox"));
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  yield* attempt("prepare-runtime", () =>
    configureWindowlessWindowsRuntime(sdk, home, platform, arch),
  );
  sdk.setDefaultBackend("local");

  const getHandle = (name: string) => attempt("get", () => sdk.Sandbox.get(name));
  const getRunning = (name: string) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("connect", async () => {
          const key = liveSandboxKey(home, name);
          const cached = liveSandboxes.get(key);
          if (cached) {
            try {
              const current = await sdk.Sandbox.get(name);
              if (current.status === "running" || current.status === "starting") {
                return cached;
              }
            } catch {
              // Fall through and reconnect below.
            }
            liveSandboxes.delete(key);
          }
          const sandbox = await handle.connectOrStart({ detached: false });
          liveSandboxes.set(key, sandbox);
          return sandbox;
        }),
      ),
    );

  // Detaching an attached handle crashes the guest on the Windows preview, so
  // operations never call detach(); the registry keeps the handle resident for
  // the server's lifetime.
  const kickDesktop = async (sandbox: Microsandbox.Sandbox): Promise<void> => {
    await sandbox.execDetached("sh", ["-lc", "exec erebus-desktop"]);
  };

  const kickDesktopSafely = async (sandbox: Microsandbox.Sandbox): Promise<void> => {
    try {
      await kickDesktop(sandbox);
    } catch {
      // microvm_desktop retries the launch after the guest is fully ready.
    }
  };

  const list: MicroVmRuntimeService["list"] = () =>
    attempt("list", async () => {
      const handles: Microsandbox.SandboxHandle[] = [];
      let cursor: string | undefined;
      do {
        const page = cursor
          ? await sdk.Sandbox.listWith((builder) => builder.limit(100).cursor(cursor!))
          : await sdk.Sandbox.listWith((builder) => builder.limit(100));
        handles.push(...page.sandboxes);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return Promise.all(handles.map(toInfo));
    });

  const get: MicroVmRuntimeService["get"] = (name) =>
    getHandle(name).pipe(Effect.flatMap((handle) => attempt("get", () => toInfo(handle))));

  const create: MicroVmRuntimeService["create"] = (input) =>
    attempt("create", async () => {
      const name = vmName(input.name);
      try {
        await sdk.Sandbox.get(name);
        throw new Error(`A microVM named ${name} already exists.`);
      } catch (cause) {
        if (!hasErrorCode(cause, "sandboxNotFound")) throw cause;
      }
      const cpus = positiveInt(input.cpus, 2, "cpus");
      const memory = positiveInt(input.memoryMiB, input.desktop ? 3072 : 2048, "memoryMiB");
      const maxCpus = positiveInt(input.maxCpus, cpus, "maxCpus");
      const maxMemory = positiveInt(input.maxMemoryMiB, memory, "maxMemoryMiB");
      if (maxCpus < cpus || maxMemory < memory) {
        throw new Error("Maximum resources cannot be lower than active resources.");
      }
      const workdir = input.workdir?.trim() || input.guestSourcePath?.trim() || "/workspace";
      const image =
        input.image?.trim() || (input.desktop !== undefined ? DEFAULT_DESKTOP_IMAGE : "debian");
      const width = input.desktop?.width ?? DEFAULT_DESKTOP_WIDTH;
      const height = input.desktop?.height ?? DEFAULT_DESKTOP_HEIGHT;
      const ports = input.ports?.map(normalizePort) ?? [];
      let desktop: MicroVmDesktop | null = null;
      let agentToken: string | null = null;
      if (input.desktop !== undefined) {
        const usedHostPorts = new Set(ports.map((port) => port.hostPort));
        const hostPort = input.desktop.hostPort ?? (await findAvailableHostPort(usedHostPorts));
        const agentPort = await findAvailableHostPort(new Set([...usedHostPorts, hostPort]));
        const desktopPort: MicroVmPort = {
          hostPort,
          guestPort: DESKTOP_GUEST_PORT,
          hostBind: "127.0.0.1",
          protocol: "tcp",
        };
        const agentPortMapping: MicroVmPort = {
          hostPort: agentPort,
          guestPort: DESKTOP_AGENT_GUEST_PORT,
          hostBind: "127.0.0.1",
          protocol: "tcp",
        };
        validatePorts([...ports, desktopPort, agentPortMapping]);
        ports.push(desktopPort, agentPortMapping);
        desktop = {
          hostPort,
          guestPort: DESKTOP_GUEST_PORT,
          width,
          height,
          agentPort,
          viewerUrl: `http://127.0.0.1:${hostPort}/vnc.html?autoconnect=1&resize=scale`,
        };
        agentToken = NodeCrypto.randomUUID();
      } else {
        validatePorts(ports);
      }
      let builder = sdk.Sandbox.builder(name)
        .image(image)
        .cpus(cpus)
        .maxCpus(maxCpus)
        .memory(memory)
        .maxMemory(maxMemory)
        .workdir(workdir)
        .ephemeral(false)
        .labels({
          "erebus.managed": "true",
          ...(input.projectId ? { "erebus.projectId": input.projectId } : {}),
          ...(input.threadId ? { "erebus.threadId": input.threadId } : {}),
          ...(ports.length > 0 ? { [PORTS_LABEL]: JSON.stringify(ports) } : {}),
          ...(desktop
            ? {
                [DESKTOP_LABEL]: JSON.stringify({
                  hostPort: desktop.hostPort,
                  guestPort: desktop.guestPort,
                  width: desktop.width,
                  height: desktop.height,
                  agentPort: desktop.agentPort,
                  agentToken,
                }),
              }
            : {}),
        });
      for (const port of ports) {
        builder =
          port.protocol === "udp"
            ? builder.portUdpBind(port.hostBind, port.hostPort, port.guestPort)
            : builder.portBind(port.hostBind, port.hostPort, port.guestPort);
      }
      if (desktop !== null) {
        builder = builder
          .script(DESKTOP_SCRIPT, desktopScript(desktop.width, desktop.height))
          .patch((patch) =>
            patch
              .text("/usr/local/bin/erebus-desktop-agent", DESKTOP_AGENT_SOURCE, {
                mode: 0o755,
              })
              .text("/etc/erebus-agent-token", `${agentToken ?? ""}\n`, { mode: 0o600 }),
          );
      }
      builder = builder.patch((patch) => patch.mkdir(workdir));
      if (input.rootDiskMiB !== undefined) {
        builder = builder.rootDisk(positiveInt(input.rootDiskMiB, 0, "rootDiskMiB"));
      } else if (desktop !== null) {
        builder = builder.rootDisk(8192);
      }
      if (input.env !== undefined) builder = builder.envs({ ...input.env });
      if (input.sourcePath !== undefined) {
        const source = NodePath.resolve(input.sourcePath);
        const stat = await NodeFSP.stat(source);
        if (!stat.isDirectory()) throw new Error("sourcePath must be a directory.");
        const guestPath = input.guestSourcePath?.trim() || "/workspace";
        builder = builder.patch((patch) => patch.copyDir(source, guestPath, { replace: true }));
      }
      try {
        const sandbox = await builder.create();
        liveSandboxes.set(liveSandboxKey(home, name), sandbox);
        if (desktop !== null) await kickDesktopSafely(sandbox);
        return toInfo(await sdk.Sandbox.get(name));
      } catch (createCause) {
        if (hasErrorCode(createCause, "sandboxAlreadyExists")) throw createCause;

        let partial: Microsandbox.SandboxHandle;
        try {
          partial = await sdk.Sandbox.get(name);
        } catch (lookupCause) {
          if (hasErrorCode(lookupCause, "sandboxNotFound")) throw createCause;
          throw new Error(
            `${errorDetail(createCause)} Failed to inspect the partial microVM: ${errorDetail(lookupCause)}`,
            { cause: lookupCause },
          );
        }

        try {
          const recovered = await partial.connectOrStart({ detached: false });
          liveSandboxes.set(liveSandboxKey(home, name), recovered);
          if (desktop !== null) await kickDesktopSafely(recovered);
          return toInfo(await partial.refresh());
        } catch (recoveryCause) {
          try {
            await partial.destroy({ force: true });
          } catch (cleanupCause) {
            throw new Error(
              `${errorDetail(createCause)} Recovery failed: ${errorDetail(recoveryCause)} Cleanup also failed: ${errorDetail(cleanupCause)}`,
              { cause: cleanupCause },
            );
          }
          throw new Error(
            `${errorDetail(createCause)} Recovery failed: ${errorDetail(recoveryCause)} The partial microVM was removed.`,
            { cause: recoveryCause },
          );
        }
      }
    });

  const control: MicroVmRuntimeService["control"] = (input) =>
    getHandle(input.name).pipe(
      Effect.flatMap((handle) =>
        attempt("control", async () => {
          const key = liveSandboxKey(home, input.name);
          switch (input.action) {
            case "start": {
              const sandbox = await handle.start();
              liveSandboxes.set(key, sandbox);
              if ((await toInfo(handle)).desktop !== null) await kickDesktopSafely(sandbox);
              break;
            }
            case "stop":
              await handle.requestStop();
              liveSandboxes.delete(key);
              break;
            case "restart": {
              const sandbox = await handle.restart({ detached: false });
              liveSandboxes.set(key, sandbox);
              if ((await toInfo(handle)).desktop !== null) await kickDesktopSafely(sandbox);
              break;
            }
            case "kill":
              await handle.kill();
              liveSandboxes.delete(key);
              break;
          }
          return toInfo(await handle.refresh());
        }),
      ),
    );

  const modify: MicroVmRuntimeService["modify"] = (input) =>
    getHandle(input.name).pipe(
      Effect.flatMap((handle) =>
        attempt("modify", async () => {
          const refreshed = await handle.refresh();
          const current = await toInfo(refreshed);
          const options = buildMicroVmModifyOptions(current, input);
          if (options !== null) await refreshed.modify(options);
          liveSandboxes.delete(liveSandboxKey(home, input.name));
          return toInfo(await refreshed.refresh());
        }),
      ),
    );

  const remove: MicroVmRuntimeService["remove"] = (input) =>
    getHandle(input.name).pipe(
      Effect.flatMap((handle) =>
        attempt("remove", async () => {
          const current = await handle.refresh();
          if (!removableWithoutForce.has(current.status) && input.force !== true) {
            throw new Error(
              `${current.name} is ${current.status}; pass force=true to remove an active microVM.`,
            );
          }
          await current.destroy({ force: input.force ?? false });
          liveSandboxes.delete(liveSandboxKey(home, input.name));
        }),
      ),
    );

  const exec: MicroVmRuntimeService["exec"] = (input) =>
    getRunning(input.name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("exec", async () => {
          if (input.detached === true) {
            const job = await sandbox.execDetachedWith(input.command, (builder) => {
              builder.args([...input.args]);
              if (input.cwd !== undefined) builder.cwd(input.cwd);
              if (input.env !== undefined) builder.envs({ ...input.env });
              if (input.timeoutMs !== undefined) builder.timeout(input.timeoutMs);
              if (input.stdin !== undefined) builder.stdinBytes(Buffer.from(input.stdin));
              else builder.stdinNull();
              return builder;
            });
            return {
              detached: true,
              jobId: job.id,
              exitCode: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }
          const output = await sandbox.execWith(input.command, (builder) => {
            builder.args([...input.args]);
            if (input.cwd !== undefined) builder.cwd(input.cwd);
            if (input.env !== undefined) builder.envs({ ...input.env });
            if (input.timeoutMs !== undefined) builder.timeout(input.timeoutMs);
            if (input.stdin !== undefined) builder.stdinBytes(Buffer.from(input.stdin));
            else builder.stdinNull();
            return builder;
          });
          const max = input.maxOutputBytes ?? 4 * 1024 * 1024;
          const stdout = truncate(output.stdout(), max);
          const stderr = truncate(output.stderr(), max);
          return {
            detached: false,
            jobId: null,
            exitCode: output.code,
            stdout: stdout.value,
            stderr: stderr.value,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          };
        }),
      ),
    );

  const jobs: MicroVmRuntimeService["jobs"] = (name) =>
    getHandle(name).pipe(Effect.flatMap((handle) => attempt("jobs", () => handle.listJobs())));

  const ensureDesktop: MicroVmRuntimeService["ensureDesktop"] = (name) =>
    getRunning(name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("desktop", async () => {
          const info = await toInfo(await sdk.Sandbox.get(name));
          if (info.desktop === null) {
            throw new Error(`${name} was not created with a desktop profile.`);
          }
          await kickDesktop(sandbox);
          return info;
        }),
      ),
    );

  const desktopAgent: MicroVmRuntimeService["desktopAgent"] = (name) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("desktop-agent", async () => {
          const state = parseDesktopLabel(configLabels(handle.config())[DESKTOP_LABEL]);
          if (state?.desktop.agentPort === undefined || state.agentToken === null) {
            throw new Error(
              `${name} has no desktop agent. Desktop VMs created before Computer Use support must be recreated.`,
            );
          }
          return { port: state.desktop.agentPort, token: state.agentToken };
        }),
      ),
    );

  const desktopAgentRequest: MicroVmRuntimeService["desktopAgentRequest"] = (name, path, body) =>
    desktopAgent(name).pipe(
      Effect.flatMap((agent) =>
        Effect.gen(function* () {
          let lastError: unknown = new Error("Desktop agent is unavailable.");
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const result = yield* Effect.result(
              Effect.tryPromise({
                try: () => requestDesktopAgent(agent, path, body),
                catch: (cause) => ({
                  cause,
                  refused: isConnectionRefused(cause),
                }),
              }),
            );
            if (result._tag === "Success") return result.success;
            lastError = result.failure.cause;
            if (!result.failure.refused && !(body === undefined && isConnectionReset(lastError))) {
              break;
            }
            yield* Effect.sleep("500 millis");
          }
          return yield* new MicroVmError({
            operation: "desktop-agent-request",
            detail: `The desktop agent for ${name} is not ready. Run microvm_desktop status until the first boot finishes. ${errorDetail(lastError)}`,
          });
        }),
      ),
    );

  const jobLogs: MicroVmRuntimeService["jobLogs"] = (name, jobId, tail) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("jobLogs", async () =>
          (await handle.getJob(jobId)).logs(tail === undefined ? {} : { tail }),
        ),
      ),
    );

  const stopJob: MicroVmRuntimeService["stopJob"] = (name, jobId) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("stopJob", async () => (await handle.getJob(jobId)).kill()),
      ),
    );

  const copyIn: MicroVmRuntimeService["copyIn"] = (input) =>
    getRunning(input.name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("copyIn", async () => {
          await sandbox.fs().copyFromHost(input.source, input.destination);
        }),
      ),
    );

  const copyOut: MicroVmRuntimeService["copyOut"] = (input) =>
    getRunning(input.name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("copyOut", async () => {
          await sandbox.fs().copyToHost(input.source, input.destination);
        }),
      ),
    );

  return {
    home,
    list,
    get,
    create,
    control,
    modify,
    remove,
    exec,
    ensureDesktop,
    desktopAgent,
    desktopAgentRequest,
    jobs,
    jobLogs,
    stopJob,
    copyIn,
    copyOut,
  } satisfies MicroVmRuntimeService;
});
