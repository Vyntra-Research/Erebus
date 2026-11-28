// @effect-diagnostics nodeBuiltinImport:off - the desktop probe is a loopback health check.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as MicroVmRuntime from "../../../microVm/MicroVmRuntime.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import { FILL_PREVIEW_VIEWPORT, MicroVmError, ThreadId } from "@t3tools/contracts";
import type {
  PreviewAutomationStatus,
  PreviewBrowserSession,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  MicroVmToolkit,
  type MicroVmCopyInput,
  type MicroVmDesktopActionInput,
  type MicroVmExecInput,
  type MicroVmJobInput,
} from "./tools.ts";
import { normalizeMicroVmProxyUrl } from "./proxyUrl.ts";

const probeDesktop = (
  viewerUrl: string,
): Promise<{ readonly ready: boolean; readonly statusCode: number | null }> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result: { readonly ready: boolean; readonly statusCode: number | null }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = NodeHttp.get(viewerUrl, { timeout: 5_000 }, (response) => {
      response.resume();
      const statusCode = response.statusCode ?? null;
      finish({
        ready: statusCode !== null && statusCode >= 200 && statusCode < 400,
        statusCode,
      });
    });
    request.once("timeout", () => {
      request.destroy();
      finish({ ready: false, statusCode: null });
    });
    request.once("error", () => finish({ ready: false, statusCode: null }));
  });

const previewSessionUrl = (session: PreviewSessionSnapshot): string | null =>
  session.navStatus._tag === "Idle" ? null : session.navStatus.url;

const desktopPreviewThreadIds = (
  invocationThreadId: ThreadId,
  ownerThreadId: string | null,
): ReadonlySet<ThreadId> =>
  new Set(
    ownerThreadId === null
      ? [invocationThreadId]
      : [invocationThreadId, ThreadId.make(ownerThreadId)],
  );

const closeDesktopPreviewSessions = Effect.fn("MicroVmToolkit.closeDesktopPreviewSessions")(
  function* (viewerUrl: string, threadIds: ReadonlySet<ThreadId>) {
    const previewManager = yield* Effect.serviceOption(PreviewManager.PreviewManager);
    if (Option.isNone(previewManager)) return;

    yield* Effect.forEach(
      threadIds,
      Effect.fn("MicroVmToolkit.closeDesktopPreviewSessionsForThread")(function* (threadId) {
        const listed = yield* previewManager.value.list({ threadId });
        yield* Effect.forEach(
          listed.sessions.filter((session) => previewSessionUrl(session) === viewerUrl),
          (session) => previewManager.value.close({ threadId, tabId: session.tabId }),
          { discard: true },
        );
      }),
      { discard: true },
    );
  },
);

const handlers = {
  microvm_list: Effect.fn("MicroVmToolkit.list")(function* () {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return { sandboxes: yield* runtime.list(), home: runtime.home };
  }),
  microvm_create: Effect.fn("MicroVmToolkit.create")(function* (input) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.create({
      ...input,
      threadId: input.threadId ?? invocation.threadId,
    });
  }),
  microvm_control: Effect.fn("MicroVmToolkit.control")(function* (input) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    const existing =
      input.action === "stop" || input.action === "kill" ? yield* runtime.get(input.name) : null;
    const result = yield* runtime.control(input);
    if (existing?.desktop) {
      yield* closeDesktopPreviewSessions(
        existing.desktop.viewerUrl,
        desktopPreviewThreadIds(invocation.threadId, existing.threadId),
      ).pipe(Effect.ignore);
    }
    return result;
  }),
  microvm_modify: Effect.fn("MicroVmToolkit.modify")(function* (input) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.modify(input);
  }),
  microvm_exec: Effect.fn("MicroVmToolkit.exec")(function* (input: MicroVmExecInput) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.exec({ ...input, args: input.args ?? [] });
  }),
  microvm_job: Effect.fn("MicroVmToolkit.job")(function* (input: MicroVmJobInput) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    if (input.action === "list") return yield* runtime.jobs(input.name);
    if (input.action === "stop") {
      yield* runtime.stopJob(input.name, input.jobId);
      return { stopped: true, jobId: input.jobId };
    }
    const entries = yield* runtime.jobLogs(input.name, input.jobId, input.tail);
    return {
      jobId: input.jobId,
      entries: entries.map((entry) => ({
        timestamp: entry.timestamp,
        source: entry.source,
        data: entry.data.toString("utf8"),
        cursor: entry.cursor,
      })),
    };
  }),
  microvm_copy: Effect.fn("MicroVmToolkit.copy")(function* (input: MicroVmCopyInput) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    const copy = { name: input.name, source: input.source, destination: input.destination };
    if (input.direction === "in") yield* runtime.copyIn(copy);
    else yield* runtime.copyOut(copy);
    return { copied: true };
  }),
  microvm_desktop: Effect.fn("MicroVmToolkit.desktop")(function* (
    input: MicroVmDesktopActionInput,
  ) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    let info = yield* runtime.get(input.name);
    if (info.desktop === null) {
      return yield* new MicroVmError({
        operation: "desktop",
        detail: `${info.name} was not created with a desktop profile.`,
      });
    }
    if (input.action === "restart") {
      yield* runtime.control({ name: input.name, action: "restart" });
      info = yield* runtime.ensureDesktop(input.name);
    } else {
      info = yield* runtime.ensureDesktop(input.name);
    }
    const desktop = info.desktop;
    if (desktop === null) {
      return yield* new MicroVmError({
        operation: "desktop",
        detail: `${info.name} lost its desktop profile.`,
      });
    }
    const probe = yield* Effect.promise(() => probeDesktop(desktop.viewerUrl));
    if (input.action !== "open" || !probe.ready) {
      return {
        name: info.name,
        desktop,
        ready: probe.ready,
        statusCode: probe.statusCode,
        preview: null,
        internalPreview: null,
      };
    }
    const previewManager = yield* Effect.serviceOption(PreviewManager.PreviewManager);
    if (Option.isSome(previewManager)) {
      const opened = yield* Effect.result(
        Effect.gen(function* () {
          const listed = yield* previewManager.value.list({ threadId: invocation.threadId });
          const matching = listed.sessions.filter(
            (session) => previewSessionUrl(session) === desktop.viewerUrl,
          );
          const reusable = matching.at(-1);

          yield* Effect.forEach(
            reusable ? matching.slice(0, -1) : matching,
            (session) =>
              previewManager.value.close({
                threadId: invocation.threadId,
                tabId: session.tabId,
              }),
            { discard: true },
          );

          if (!reusable) {
            return yield* previewManager.value.open({
              threadId: invocation.threadId,
              url: desktop.viewerUrl,
              viewport: FILL_PREVIEW_VIEWPORT,
            });
          }

          yield* previewManager.value.navigate({
            threadId: invocation.threadId,
            tabId: reusable.tabId,
            url: desktop.viewerUrl,
          });
          return yield* previewManager.value.resize({
            threadId: invocation.threadId,
            tabId: reusable.tabId,
            viewport: FILL_PREVIEW_VIEWPORT,
          });
        }),
      );
      if (opened._tag === "Success") {
        // A server preview session is not visible on its own: the renderer
        // owns the Review pane and the floating mini preview. Ask the
        // automation host to present the tab that already exists, so the
        // desktop lands in front of the user instead of sitting unseen in
        // server state. Presentation is best-effort; a missing automation
        // host must not fail an otherwise successful open.
        const scope = yield* Effect.option(McpInvocationContext.requireMcpCapability("preview"));
        if (Option.isSome(scope)) {
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          yield* broker
            .invoke<PreviewAutomationStatus>({
              scope: scope.value,
              operation: "open",
              tabId: opened.success.tabId,
              input: {
                open: true,
                show: true,
                reuseExistingTab: true,
              },
              timeoutMs: 10_000,
            })
            .pipe(Effect.ignore);
        }
        return {
          name: info.name,
          desktop,
          ready: true,
          statusCode: probe.statusCode,
          preview: null,
          internalPreview: opened.success,
        };
      }
    }
    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.mapError(
        (cause) =>
          new MicroVmError({
            operation: "desktop-open",
            detail: cause.message,
          }),
      ),
    );
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const preview = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: {
          url: desktop.viewerUrl,
          open: true,
          show: true,
          reuseExistingTab: true,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MicroVmError({
              operation: "desktop-open",
              detail: cause.message,
            }),
        ),
      );
    return {
      name: info.name,
      desktop,
      ready: true,
      statusCode: probe.statusCode,
      preview,
      internalPreview: null,
    };
  }),
  microvm_browser_start: Effect.fn("MicroVmToolkit.browserStart")(function* (input: {
    name: string;
    url?: string | undefined;
    proxyUrl?: string | undefined;
    caPem?: string | undefined;
  }) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    yield* runtime.ensureDesktop(input.name);
    const proxyUrl =
      input.proxyUrl === undefined ? undefined : normalizeMicroVmProxyUrl(input.proxyUrl);
    const result = yield* runtime.desktopBrowserStart(input.name, {
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(proxyUrl === undefined ? {} : { proxyUrl }),
      ...(input.caPem === undefined ? {} : { caPem: input.caPem }),
      ...(proxyUrl === undefined ? {} : { restart: true }),
    });
    return { ok: true, started: result.started };
  }),
  microvm_browser_import: Effect.fn("MicroVmToolkit.browserImport")(function* (input: {
    name: string;
    session: PreviewBrowserSession;
  }) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    yield* runtime.ensureDesktop(input.name);
    yield* runtime.desktopBrowserStart(input.name, { url: input.session.url });
    yield* runtime.desktopBrowserImport(input.name, input.session);
    return { ok: true };
  }),
  microvm_remove: Effect.fn("MicroVmToolkit.remove")(function* (input) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    const existing = yield* runtime.get(input.name);
    yield* runtime.remove(input);
    if (existing.desktop) {
      yield* closeDesktopPreviewSessions(
        existing.desktop.viewerUrl,
        desktopPreviewThreadIds(invocation.threadId, existing.threadId),
      ).pipe(Effect.ignore);
    }
    return { removed: true };
  }),
} satisfies Parameters<typeof MicroVmToolkit.toLayer>[0];

export const MicroVmToolkitHandlersLive = MicroVmToolkit.toLayer(handlers);
