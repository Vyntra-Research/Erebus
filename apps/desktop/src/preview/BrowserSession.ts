// @effect-diagnostics nodeBuiltinImport:off - Electron preview partitions live in sessionData and proxy CAs are parsed locally.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopPreviewProxyConfiguration } from "@t3tools/contracts";
import type { Certificate, Session } from "electron";
import { app, session, webContents } from "electron";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";
const PREVIEW_PARTITION_DIRECTORY_PREFIX = PREVIEW_PARTITION_PREFIX.slice("persist:".length);
const STALE_PREVIEW_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const NAMED_PROFILE_SCOPE_SEPARATOR = "\u0000erebus-browser-profile\u0000";
const USE_CHROMIUM_CERTIFICATE_RESULT = -3;
const CERTIFICATE_AUTHORITY_INVALID_ERROR_CODE = -202;

export function deriveBrowserSessionScope(scope: string, browserProfileId?: string): string {
  return browserProfileId === undefined
    ? scope
    : `${scope}${NAMED_PROFILE_SCOPE_SEPARATOR}${browserProfileId}`;
}

export function normalizeLoopbackHttpProxyUrl(proxyUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new TypeError("Proxy URL is invalid.");
  }

  if (parsed.protocol !== "http:") {
    throw new TypeError("Proxy URL must use HTTP.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== "127.0.0.1" &&
    hostname !== "::1" &&
    hostname !== "[::1]" &&
    hostname !== "localhost"
  ) {
    throw new TypeError("Proxy URL must use a loopback host.");
  }
  if (parsed.port === "") {
    throw new TypeError("Proxy URL must include a port.");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Proxy URL must contain only a loopback origin.");
  }
  return parsed.origin;
}

function normalizeCertificateFingerprint(fingerprint: string): string {
  const normalized = fingerprint.replaceAll(":", "").trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new TypeError("Proxy CA fingerprint must be a SHA-256 fingerprint.");
  }
  return normalized;
}

export function resolveProxyCaFingerprint(config: DesktopPreviewProxyConfiguration): string {
  const suppliedFingerprint =
    config.caFingerprint === undefined
      ? undefined
      : normalizeCertificateFingerprint(config.caFingerprint);
  const pemFingerprint =
    config.caCertificatePem === undefined
      ? undefined
      : normalizeCertificateFingerprint(
          new NodeCrypto.X509Certificate(config.caCertificatePem).fingerprint256,
        );

  if (suppliedFingerprint !== undefined && pemFingerprint !== undefined) {
    if (suppliedFingerprint !== pemFingerprint) {
      throw new TypeError("Proxy CA fingerprint does not match the supplied certificate.");
    }
    return suppliedFingerprint;
  }
  if (suppliedFingerprint !== undefined) return suppliedFingerprint;
  if (pemFingerprint !== undefined) return pemFingerprint;
  throw new TypeError("Proxy CA fingerprint or certificate is required.");
}

function certificateFingerprint(certificate: Certificate): string | undefined {
  try {
    return normalizeCertificateFingerprint(certificate.fingerprint);
  } catch {
    return undefined;
  }
}

export function certificateChainEndsAt(
  certificate: Certificate,
  trustedCaFingerprint: string,
): boolean {
  const normalizedTrustedFingerprint = normalizeCertificateFingerprint(trustedCaFingerprint);
  const seen = new Set<Certificate>();
  let current: Certificate | undefined = certificate;

  for (let depth = 0; depth < 32 && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);

    const currentFingerprint = certificateFingerprint(current);
    const issuer: Certificate | undefined = current.issuerCert;
    if (issuer === undefined) return currentFingerprint === normalizedTrustedFingerprint;
    const issuerFingerprint = certificateFingerprint(issuer);
    if (issuer === current || issuerFingerprint === currentFingerprint) {
      return currentFingerprint === normalizedTrustedFingerprint;
    }
    current = issuer;
  }
  return false;
}

export function certificateWasSignedBy(
  certificate: Certificate,
  trustedCaCertificate: NodeCrypto.X509Certificate,
): boolean {
  try {
    const leaf = new NodeCrypto.X509Certificate(certificate.data);
    return leaf.checkIssued(trustedCaCertificate) && leaf.verify(trustedCaCertificate.publicKey);
  } catch {
    return false;
  }
}

function listStalePreviewPartitions(nowMs: number): ReadonlyArray<string> {
  if (typeof app?.getPath !== "function") return [];
  const root = NodePath.join(app.getPath("sessionData"), "Partitions");
  if (!NodeFS.existsSync(root)) return [];
  return NodeFS.readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.name.startsWith(PREVIEW_PARTITION_DIRECTORY_PREFIX),
    )
    .flatMap((entry) => {
      const stat = NodeFS.lstatSync(NodePath.join(root, entry.name));
      return stat.mtimeMs <= nowMs - STALE_PREVIEW_CACHE_AGE_MS ? [`persist:${entry.name}`] : [];
    });
}

// Permissions granted to preview web content. `clipboard-sanitized-write` is the
// Electron permission behind `navigator.clipboard.writeText()` — note it is NOT
// `clipboard-write`, which is not a valid Electron permission name. Async
// clipboard writes are gated by the permission *check* handler (not only the
// request handler), so both handlers must allow it; otherwise built-in "Copy"
// buttons — e.g. the Next.js / Vercel error overlay — fail with
// `Failed to execute 'writeText' on 'Clipboard': Write permission denied`.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
  "geolocation",
  // Deliberately NOT local-fonts: preview sessions run untrusted web content,
  // and silently granting it would hand every page the user's installed-font
  // fingerprint (and font file bytes via FontData.blob()). The app's own font
  // picker runs in the main window session, which is unaffected by this list.
]);

export class BrowserSessionPartitionDerivationError extends Schema.TaggedErrorClass<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  {
    scope: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedErrorClass<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  {
    scope: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedErrorClass<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedErrorClass<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
  }
}

export class BrowserSessionProxyValidationError extends Schema.TaggedErrorClass<BrowserSessionProxyValidationError>()(
  "BrowserSessionProxyValidationError",
  {
    scope: Schema.String,
    browserProfileId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid desktop preview proxy configuration for scope ${this.scope}.`;
  }
}

export class BrowserSessionProxyConfigurationError extends Schema.TaggedErrorClass<BrowserSessionProxyConfigurationError>()(
  "BrowserSessionProxyConfigurationError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to configure the desktop preview proxy for partition ${this.partition}.`;
  }
}

export class BrowserProfileInUseError extends Schema.TaggedErrorClass<BrowserProfileInUseError>()(
  "BrowserProfileInUseError",
  {
    profileId: Schema.String,
    activeTabCount: Schema.Number,
  },
) {
  override get message(): string {
    return `Close the ${this.activeTabCount} open browser tab${this.activeTabCount === 1 ? "" : "s"} using profile ${this.profileId} before deleting it.`;
  }
}
export const isBrowserProfileInUseError = Schema.is(BrowserProfileInUseError);

export class BrowserProfilePartitionClearError extends Schema.TaggedErrorClass<BrowserProfilePartitionClearError>()(
  "BrowserProfilePartitionClearError",
  {
    profileId: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear browser profile ${this.profileId} partition ${this.partition}.`;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;
export const isBrowserSessionGetSessionError = Schema.is(BrowserSessionGetSessionError);

export const BrowserSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionStorageClearError,
  BrowserSessionCacheClearError,
  BrowserSessionProxyValidationError,
  BrowserSessionProxyConfigurationError,
  BrowserProfileInUseError,
  BrowserProfilePartitionClearError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;
export const isBrowserSessionError = Schema.is(BrowserSessionError);

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope?: string,
      browserProfileId?: string,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    readonly getSession: (
      scope?: string,
      browserProfileId?: string,
    ) => Effect.Effect<Session, BrowserSessionGetSessionError>;
    readonly configureProxy: (
      scope: string | undefined,
      browserProfileId: string | undefined,
      config: DesktopPreviewProxyConfiguration | null,
    ) => Effect.Effect<
      void,
      | BrowserSessionGetSessionError
      | BrowserSessionProxyValidationError
      | BrowserSessionProxyConfigurationError
    >;
    readonly clearCookies: () => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: () => Effect.Effect<void, BrowserSessionCacheClearError>;
    readonly clearProfilePartitions: (
      profileId: string,
      partitions: readonly string[],
    ) => Effect.Effect<void, BrowserProfileInUseError | BrowserProfilePartitionClearError>;
  }
>()("@t3tools/desktop/preview/BrowserSession") {}

export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Crypto.Crypto;
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());
  const proxyConfigurationLocksRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, Semaphore.Semaphore>
  >(new Map());

  const pruneStalePreviewPartitions = Effect.fn("BrowserSession.pruneStalePreviewPartitions")(
    function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const stalePartitions = yield* Effect.try(() => listStalePreviewPartitions(nowMs)).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );
      yield* Effect.forEach(
        stalePartitions,
        (partition) =>
          Effect.gen(function* () {
            const activeSessions = yield* SynchronizedRef.get(sessionsRef);
            if (activeSessions.has(partition)) return;
            yield* Effect.tryPromise(async () => {
              const staleSession = session.fromPartition(partition);
              staleSession.setCertificateVerifyProc(null);
              await staleSession.setProxy({ mode: "direct" });
              await staleSession.closeAllConnections();
              await staleSession.clearCache();
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to prune an inactive preview partition", {
                  partition,
                  cause,
                }),
              ),
            );
          }),
        { concurrency: 2, discard: true },
      );
    },
  );

  yield* Effect.forkDetach(pruneStalePreviewPartitions());

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (
    scope = "shared",
    browserProfileId?: string,
  ) {
    const partitionScope = deriveBrowserSessionScope(scope, browserProfileId);
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(partitionScope)).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserSessionPartitionDerivationError({
            scope,
            cause,
          }),
      ),
    );
    return `${PREVIEW_PARTITION_PREFIX}${Encoding.encodeHex(digest).slice(0, 20)}`;
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (
    scope = "shared",
    browserProfileId?: string,
  ) {
    const partition = yield* getPartition(scope, browserProfileId);
    const browserSession = yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          const userAgent = browserSession
            .getUserAgent()
            .replace(/Electron\/[\d.]+ /, "")
            .replace(/\s*t3code\/[\d.]+/, "");
          browserSession.setUserAgent(userAgent);
          browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
            callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission));
          });
          browserSession.setPermissionCheckHandler((_webContents, permission) =>
            ALLOWED_PREVIEW_PERMISSIONS.has(permission),
          );
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) =>
          new BrowserSessionCreationError({
            scope,
            partition,
            cause,
          }),
      });
    });
    return browserSession;
  });

  return BrowserSession.of({
    getPartition,
    isPartition: (partition) => partition.startsWith(PREVIEW_PARTITION_PREFIX),
    getSession,
    configureProxy: Effect.fn("BrowserSession.configureProxy")(function* (
      scope = "shared",
      browserProfileId,
      config,
    ) {
      const proxySettings =
        config === null
          ? null
          : yield* Effect.try({
              try: () => ({
                proxyRules: normalizeLoopbackHttpProxyUrl(config.proxyUrl),
                trustedCaFingerprint: resolveProxyCaFingerprint(config),
                trustedCaCertificate:
                  config.caCertificatePem === undefined
                    ? undefined
                    : new NodeCrypto.X509Certificate(config.caCertificatePem),
              }),
              catch: (cause) =>
                new BrowserSessionProxyValidationError({
                  scope,
                  browserProfileId,
                  cause,
                }),
            });
      const partition = yield* getPartition(scope, browserProfileId);
      const browserSession = yield* getSession(scope, browserProfileId);
      const proxyConfigurationLock = yield* SynchronizedRef.modifyEffect(
        proxyConfigurationLocksRef,
        (locks) => {
          const existing = locks.get(partition);
          if (existing !== undefined) return Effect.succeed([existing, locks] as const);
          return Semaphore.make(1).pipe(
            Effect.map((lock) => {
              const next = new Map(locks);
              next.set(partition, lock);
              return [lock, next] as const;
            }),
          );
        },
      );

      yield* proxyConfigurationLock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            if (proxySettings === null) {
              browserSession.setCertificateVerifyProc(null);
              try {
                await browserSession.setProxy({ mode: "direct" });
              } finally {
                await browserSession.closeAllConnections();
              }
              return;
            }

            browserSession.setCertificateVerifyProc((request, callback) => {
              const authorityIsUnknown =
                request.errorCode === CERTIFICATE_AUTHORITY_INVALID_ERROR_CODE ||
                request.verificationResult === "CERT_AUTHORITY_INVALID" ||
                request.verificationResult === "net::ERR_CERT_AUTHORITY_INVALID";
              const usesCaptureCa =
                certificateChainEndsAt(request.certificate, proxySettings.trustedCaFingerprint) ||
                certificateChainEndsAt(
                  request.validatedCertificate,
                  proxySettings.trustedCaFingerprint,
                ) ||
                (proxySettings.trustedCaCertificate !== undefined &&
                  (certificateWasSignedBy(
                    request.certificate,
                    proxySettings.trustedCaCertificate,
                  ) ||
                    certificateWasSignedBy(
                      request.validatedCertificate,
                      proxySettings.trustedCaCertificate,
                    )));
              callback(authorityIsUnknown && usesCaptureCa ? 0 : USE_CHROMIUM_CERTIFICATE_RESULT);
            });

            try {
              await browserSession.setProxy({
                mode: "fixed_servers",
                proxyRules: proxySettings.proxyRules,
                proxyBypassRules: "<-loopback>",
              });
              await browserSession.closeAllConnections();
            } catch (cause) {
              browserSession.setCertificateVerifyProc(null);
              try {
                await browserSession.setProxy({ mode: "direct" });
                await browserSession.closeAllConnections();
              } catch {
                // Preserve the original failure; the next configure call retries cleanup.
              }
              throw cause;
            }
          },
          catch: (cause) =>
            new BrowserSessionProxyConfigurationError({
              partition,
              cause,
            }),
        }),
      );
    }),
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
              }),
            catch: (cause) =>
              new BrowserSessionStorageClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new BrowserSessionCacheClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearProfilePartitions: Effect.fn("BrowserSession.clearProfilePartitions")(
      function* (profileId, partitions) {
        const uniquePartitions = [...new Set(partitions)];
        const profileSessions = uniquePartitions.map((partition) => ({
          partition,
          browserSession: session.fromPartition(partition),
        }));
        const sessionSet = new Set(profileSessions.map(({ browserSession }) => browserSession));
        const activeTabCount = webContents
          .getAllWebContents()
          .filter(
            (contents) =>
              !contents.isDestroyed() &&
              contents.getType() === "webview" &&
              sessionSet.has(contents.session),
          ).length;
        if (activeTabCount > 0) {
          return yield* new BrowserProfileInUseError({ profileId, activeTabCount });
        }

        yield* Effect.forEach(
          profileSessions,
          ({ partition, browserSession }) =>
            Effect.tryPromise({
              try: async () => {
                browserSession.setCertificateVerifyProc(null);
                await browserSession.setProxy({ mode: "direct" });
                await browserSession.closeAllConnections();
                await browserSession.clearStorageData();
                await browserSession.clearCache();
                browserSession.flushStorageData();
              },
              catch: (cause) =>
                new BrowserProfilePartitionClearError({ profileId, partition, cause }),
            }),
          { concurrency: 2, discard: true },
        );

        yield* SynchronizedRef.update(sessionsRef, (sessions) => {
          if (uniquePartitions.every((partition) => !sessions.has(partition))) return sessions;
          const next = new Map(sessions);
          for (const partition of uniquePartitions) next.delete(partition);
          return next;
        });
        yield* SynchronizedRef.update(proxyConfigurationLocksRef, (locks) => {
          if (uniquePartitions.every((partition) => !locks.has(partition))) return locks;
          const next = new Map(locks);
          for (const partition of uniquePartitions) next.delete(partition);
          return next;
        });
      },
    ),
  });
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effect(BrowserSession, make);
