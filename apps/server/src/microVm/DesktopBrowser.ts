// @effect-diagnostics nodeBuiltinImport:off - the desktop browser CDP endpoint is host-local HTTP.
import * as NodeHttp from "node:http";

import type { PreviewBrowserSession } from "@t3tools/contracts";

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly sessionId?: string;
}

interface CdpTargetInfo {
  readonly targetId: string;
  readonly type: string;
}

const readJson = (port: number, path: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path, timeout: 5_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) !== 200) {
          reject(new Error(`CDP discovery failed with HTTP ${response.statusCode ?? 500}.`));
          return;
        }
        try {
          resolve(JSON.parse(text) as Record<string, unknown>);
        } catch {
          reject(new Error("CDP discovery returned invalid JSON."));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("CDP discovery timed out.")));
    request.once("error", reject);
  });

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to the desktop browser CDP endpoint.")),
      { once: true },
    );
  });

class CdpConnection {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? "CDP command failed."));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  close(): void {
    this.#socket.close();
  }
}

const attachToPage = async (
  connection: CdpConnection,
): Promise<{ targetId: string; sessionId: string }> => {
  const targets = (await connection.send("Target.getTargets")) as {
    readonly targetInfos?: ReadonlyArray<CdpTargetInfo>;
  };
  let target = targets.targetInfos?.find((candidate) => candidate.type === "page");
  if (target === undefined) {
    const created = (await connection.send("Target.createTarget", {
      url: "about:blank",
    })) as { readonly targetId?: string };
    if (created.targetId === undefined) throw new Error("CDP did not create a browser page.");
    target = { targetId: created.targetId, type: "page" };
  }
  const attached = (await connection.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })) as { readonly sessionId?: string };
  if (attached.sessionId === undefined) throw new Error("CDP did not attach to the browser page.");
  return { targetId: target.targetId, sessionId: attached.sessionId };
};

export async function importSessionIntoDesktopBrowser(
  cdpPort: number,
  session: PreviewBrowserSession,
): Promise<void> {
  const version = await readJson(cdpPort, "/json/version");
  const webSocketUrl = version.webSocketDebuggerUrl;
  if (typeof webSocketUrl !== "string" || webSocketUrl.length === 0) {
    throw new Error("The desktop browser did not expose a CDP WebSocket endpoint.");
  }
  const socket = await openSocket(webSocketUrl);
  const connection = new CdpConnection(socket);
  try {
    const { sessionId } = await attachToPage(connection);
    if (session.cookies.length > 0) {
      await connection.send("Network.enable", {}, sessionId);
      await connection.send(
        "Network.setCookies",
        {
          cookies: session.cookies
            .filter((cookie) => cookie.domain.length > 0)
            .map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure ?? false,
              httpOnly: cookie.httpOnly ?? false,
              ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
              ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
            })),
        },
        sessionId,
      );
    }
    const origins = session.origins.filter(
      (origin) =>
        Object.keys(origin.localStorage).length > 0 ||
        Object.keys(origin.sessionStorage ?? {}).length > 0,
    );
    if (origins.length > 0) {
      await connection.send("DOMStorage.enable", {}, sessionId);
      for (const origin of origins) {
        for (const [key, value] of Object.entries(origin.localStorage)) {
          await connection.send(
            "DOMStorage.setDOMStorageItem",
            {
              storageId: { securityOrigin: origin.origin, isLocalStorage: true },
              key,
              value,
            },
            sessionId,
          );
        }
        for (const [key, value] of Object.entries(origin.sessionStorage ?? {})) {
          await connection.send(
            "DOMStorage.setDOMStorageItem",
            {
              storageId: { securityOrigin: origin.origin, isLocalStorage: false },
              key,
              value,
            },
            sessionId,
          );
        }
      }
    }
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Page.navigate", { url: session.url }, sessionId);
  } finally {
    connection.close();
  }
}
