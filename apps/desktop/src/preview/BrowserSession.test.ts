// @effect-diagnostics nodeBuiltinImport:off - Tests build temporary Electron partition fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Certificate } from "electron";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessionDataPath, sessions, openWebContents } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessionDataPath: { value: "" },
  openWebContents: [] as Array<{
    readonly getType: () => string;
    readonly isDestroyed: () => boolean;
    readonly session: unknown;
  }>,
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly closeAllConnections: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn>;
      readonly flushStorageData: ReturnType<typeof vi.fn>;
      readonly setCertificateVerifyProc: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setProxy: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => sessionDataPath.value,
  },
  session: {
    fromPartition,
  },
  webContents: {
    getAllWebContents: () => openWebContents,
  },
}));

import * as BrowserSession from "./BrowserSession.ts";

const layer = BrowserSession.layer.pipe(Layer.provide(NodeServices.layer));
const trustedCaFingerprint = "AA".repeat(32);
const trustedCaPem = `-----BEGIN CERTIFICATE-----
MIIC4zCCAcugAwIBAgIUELcZ0dLnf+vLtTqEbdsZJoVepNMwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPVHJ1c3RlZCBUZXN0IENBMB4XDTI2MTEyMTAxMTMxNVoX
DTI2MTEyMzAxMTMxNVowGjEYMBYGA1UEAwwPVHJ1c3RlZCBUZXN0IENBMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA86+y7rlGJtCXRE99TyIfnv58KAVu
3Ac9j/LwMiZKmNODJwKc/zbqs5isRU1sr+uJzYBl6ZJiGDLlvWE33Ia9HIMI9UHH
afSwS/C/agdoswygKUZA94b9htu2hfiabKC1VvAEiBaD+srUJkwj1M2WvbGYm/rD
0lmyrF9v9kfQWa75Fwv+DckmYcEca/kTRrO/j1oDyXODF2itxMXsy1uORf4C6fj7
TVdDBUVNhTIhV54aWQ/KuvaQteuTUNtOooaabIT7MTPXeSV/PrXeXoZ34sQq1KKd
LImAuYX0DyxCzvEzf0V7D0RsEVUlkcsgY4gBAH2APbhERRSm5X/S+DjN+QIDAQAB
oyEwHzAdBgNVHQ4EFgQU9GWP6G+6jCsSr67+Qc01kedGVGwwDQYJKoZIhvcNAQEL
BQADggEBACBmdYc4zs2DFtYYtly2InYmjhtb0SU/MCk9sOFB+eHJi8qnrvOlp2hT
mIFdDDfRxra5pVvkjHAGX0GR4JvYl0U9SxCVgMBDh67RNAmXrzRQJI8XvgsGBTnl
WkEMKYAqT/zrsRxvhKhcHvEXQHlxUpJlfiv3WI9O8nIylNROoqv5v+l50ERftk3f
8c+px01QGGaVm74EfnTR42oDFuTEMjO8bG+0iqRVXcCaZHNleV0UmJf6mOGQVbGq
t4jKCssnrwKhAHwEfQJiRL4sJ324Ry+ZyNWYnYXmB2/XZ/Sw/6HIdROW1/IuAmBt
z4sm6atu0GkUCV19Fg3aY0ya0jME2Ws=
-----END CERTIFICATE-----`;
const trustedLeafPem = `-----BEGIN CERTIFICATE-----
MIIDATCCAemgAwIBAgIUIlM6Hl3lV1DyzHqUWdc56HIvGAgwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPVHJ1c3RlZCBUZXN0IENBMB4XDTI2MTEyMTAxMTMxNVoX
DTI2MTEyMzAxMTMxNVowFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmWHrQ9L5PLcJSjq+b22E9UVlhbwnn6+U
oggEKU3lGQsqkkdH4+pBKOqmuN132gCFpJHRU3ECS7/ROjH2vSvY+QJya/COL+qG
Lx+228QhtgR1mGHiA8NNpwVtRZ3gBvYvR6C6TiHSQmWFbjHwjJIb9SZz0ZKPijim
rG5mMcEZJtgGyHfngnLVLvKIPsGhIiel3TIslQfsxFlreqOcoO/wnZ2j4tn3BlVQ
gKkNWie9tP8Zy2ya53bqFUVqqMwqeeJ96/8dpS5b/zuWWgcqRdmMYUeqB6JVF0D9
7DEC588oEf0XlybqzseIqNnqzmt2f0hL2iwCtKkj/imd7nf0YNAa+wIDAQABo0Iw
QDAdBgNVHQ4EFgQUkVA7Obi7lGfd0An8kGSWQkkpFf4wHwYDVR0jBBgwFoAU9GWP
6G+6jCsSr67+Qc01kedGVGwwDQYJKoZIhvcNAQELBQADggEBAIYkovusc4JIlo3B
Fck+kIqydzGXNK/396KDPnE/W1aiJCRhu33OWO0MOUYn9jPABX/P5zIbhQXiC7yM
S2DVxGtvSOfhLXqIsAWmKuBIM9YlmJAEcL4vj/rXO+tgcI3ZluXUWtamOkubWD3A
yRBTzrYCZ4/fEdGl1GlbLkt2ZjdPSW3N+thCVQGljD6O87DJlnuC3qfTDitf2xI4
FTFL9MH3leQeT3GgpPGozBxhST2Pyh/P08aN+EUY+13KHSP8Ajk8Je0wTgQcLDIC
ko6lhBOU2VACYxOcVQORxkJPl5uEMKGVyKiKxS4YvuJplUCRLazevV247KqA2y2R
eVMM6MU=
-----END CERTIFICATE-----`;
const foreignLeafPem = `-----BEGIN CERTIFICATE-----
MIIDATCCAemgAwIBAgIUBKYToMPjkNWPRtZUYBpI+h3hHZ8wDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPRm9yZWlnbiBUZXN0IENBMB4XDTI2MTEyMTAxMTMxNloX
DTI2MTEyMzAxMTMxNlowFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs8/eYf+4uFs2ZSW9Ir2cNhdW7QAMR6U7
AdmkJ+kpYoREZXRVDtifCUEdzVPwpBevVPcgvZGRD02FjdeB/67eir72HdJO1jn7
yGhp+jR02zUx6+fl96aQrAvqOcyhGTbtcE1Xz6OKQnOa1x8GMqiGSeA6N6gb1icg
cd+PHZm8rCrlyBNnVQqqRhL9/xidb8so+BfxtaTp7qgZm7uJbqlKCP0SZ6EZFUoa
EPC7dYYEIjbLoWdHcV1q4ZUsLoXkHUeEsgqLo4hajGqqb2GorAVvsQSuL0NpkjdT
gZmL1F4FCEtaAxobWnGhS2wZegciUvrcu0YGqCMUAwp2BXpSA1GghwIDAQABo0Iw
QDAdBgNVHQ4EFgQUnG6K4keoQNvnfejyQ/m6k6vWFVcwHwYDVR0jBBgwFoAUA641
wP74V5rdoX0g0BB7AbhAUqwwDQYJKoZIhvcNAQELBQADggEBALeNyciFbOPc/ZaW
4L7VnNP9zAiVUepVmucp7OC/ex0RszeJWamuEcR1XWv7J9szAI6SdoGm708gpD1K
VF+4MZ0E846ONtDuMxsfhEOHCzVyEQEckN1Q+X30uaHbQrP5IZVaPCJobN55bAOz
IlikCtq4L3Fzi3kz5J/n1aJIlHmrzFwHWj+Mdx+r6vv7jngU3wIrRunM2lB9niVQ
CtaJvUx1PtgrwXPEIcrOMzkLVQu8t0NUtowVJthfubV9gU6fPxjkFojhbkI9wegT
QE4O9qGr6kegiokRHrVpdkVjTKxek5j4ykMn93GezmARjnoetFeIkMTKoDyGaLvf
+lMs580=
-----END CERTIFICATE-----`;

function makeCertificate(fingerprint: string, issuer?: Certificate, data = ""): Certificate {
  const certificate = {
    data,
    fingerprint,
    issuer: {},
    issuerCert: undefined,
    issuerName: "",
    serialNumber: "",
    subject: {},
    subjectName: "",
    validExpiry: 0,
    validStart: 0,
  } as unknown as Certificate;
  certificate.issuerCert = issuer ?? certificate;
  return certificate;
}

describe("BrowserSession", () => {
  beforeEach(() => {
    sessionDataPath.value = NodePath.join(NodeOS.tmpdir(), "erebus-missing-session-data");
    sessions.clear();
    openWebContents.length = 0;
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const existing = sessions.get(partition);
      if (existing !== undefined) return existing;
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        closeAllConnections: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        flushStorageData: vi.fn(),
        getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"),
        setCertificateVerifyProc: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setProxy: vi.fn(() => Promise.resolve()),
        setUserAgent: vi.fn(),
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:t3code-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the historical default partition and isolates named profiles", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const historical = yield* browserSessions.getPartition("scope-a");
      const explicitDefault = yield* browserSessions.getPartition("scope-a", undefined);
      const firstProfile = yield* browserSessions.getPartition("scope-a", "account-a");
      const secondProfile = yield* browserSessions.getPartition("scope-a", "account-b");

      assert.strictEqual(historical, "persist:t3code-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(explicitDefault, historical);
      assert.strictEqual(firstProfile, "persist:t3code-preview-707916b6dded6ee7118d");
      assert.strictEqual(secondProfile, "persist:t3code-preview-897e90a428750f087bf6");
      assert.notEqual(firstProfile, secondProfile);

      const first = yield* browserSessions.getSession("scope-a", "account-a");
      const firstAgain = yield* browserSessions.getSession("scope-a", "account-a");
      const second = yield* browserSessions.getSession("scope-a", "account-b");
      assert.strictEqual(first, firstAgain);
      assert.notStrictEqual(first, second);
      assert.strictEqual(sessions.size, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refuses to clear an in-use profile and clears every recorded partition after close",
    () =>
      Effect.gen(function* () {
        const browserSessions = yield* BrowserSession.BrowserSession;
        const partition = yield* browserSessions.getPartition("scope-a", "account-a");
        const profileSession = yield* browserSessions.getSession("scope-a", "account-a");
        openWebContents.push({
          getType: () => "webview",
          isDestroyed: () => false,
          session: profileSession,
        });

        const inUse = yield* browserSessions
          .clearProfilePartitions("account-a", [partition])
          .pipe(Effect.flip);
        assert.instanceOf(inUse, BrowserSession.BrowserProfileInUseError);
        assert.strictEqual(inUse.activeTabCount, 1);

        openWebContents.length = 0;
        yield* browserSessions.clearProfilePartitions("account-a", [partition, partition]);

        const stored = sessions.get(partition)!;
        assert.strictEqual(stored.setProxy.mock.calls.length, 1);
        assert.deepEqual(stored.setProxy.mock.calls[0], [{ mode: "direct" }]);
        assert.strictEqual(stored.closeAllConnections.mock.calls.length, 1);
        assert.strictEqual(stored.clearStorageData.mock.calls.length, 1);
        assert.strictEqual(stored.clearCache.mock.calls.length, 1);
        assert.strictEqual(stored.flushStorageData.mock.calls.length, 1);
      }).pipe(Effect.provide(layer)),
  );

  it("accepts only loopback HTTP proxy origins", () => {
    assert.strictEqual(
      BrowserSession.normalizeLoopbackHttpProxyUrl("http://127.0.0.1:8080"),
      "http://127.0.0.1:8080",
    );
    assert.strictEqual(
      BrowserSession.normalizeLoopbackHttpProxyUrl("http://[::1]:9090"),
      "http://[::1]:9090",
    );
    assert.strictEqual(
      BrowserSession.normalizeLoopbackHttpProxyUrl("http://localhost:3000"),
      "http://localhost:3000",
    );

    for (const proxyUrl of [
      "https://127.0.0.1:8080",
      "http://192.168.1.20:8080",
      "http://127.0.0.1",
      "http://127.0.0.1:8080/path",
      "http://user:pass@127.0.0.1:8080",
    ]) {
      assert.throws(() => BrowserSession.normalizeLoopbackHttpProxyUrl(proxyUrl));
    }
  });

  it.effect("keeps one proxy per profile while allowing profiles to coexist", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.configureProxy("scope-a", "account-a", {
        proxyUrl: "http://127.0.0.1:8080",
        caFingerprint: trustedCaFingerprint,
      });
      yield* browserSessions.configureProxy("scope-a", "account-b", {
        proxyUrl: "http://127.0.0.1:8081",
        caFingerprint: trustedCaFingerprint,
      });
      yield* browserSessions.configureProxy("scope-a", "account-a", {
        proxyUrl: "http://127.0.0.1:8082",
        caFingerprint: trustedCaFingerprint,
      });

      const firstPartition = yield* browserSessions.getPartition("scope-a", "account-a");
      const secondPartition = yield* browserSessions.getPartition("scope-a", "account-b");
      const first = sessions.get(firstPartition);
      const second = sessions.get(secondPartition);
      assert.isDefined(first);
      assert.isDefined(second);
      assert.deepEqual(first.setProxy.mock.calls, [
        [
          {
            mode: "fixed_servers",
            proxyRules: "http://127.0.0.1:8080",
            proxyBypassRules: "<-loopback>",
          },
        ],
        [
          {
            mode: "fixed_servers",
            proxyRules: "http://127.0.0.1:8082",
            proxyBypassRules: "<-loopback>",
          },
        ],
      ]);
      assert.deepEqual(second.setProxy.mock.calls, [
        [
          {
            mode: "fixed_servers",
            proxyRules: "http://127.0.0.1:8081",
            proxyBypassRules: "<-loopback>",
          },
        ],
      ]);
      assert.strictEqual(first.closeAllConnections.mock.calls.length, 2);
      assert.strictEqual(second.closeAllConnections.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trusts only an unknown-authority chain ending at the configured CA", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.configureProxy("scope-a", "account-a", {
        proxyUrl: "http://127.0.0.1:8080",
        caFingerprint: trustedCaFingerprint,
      });
      const partition = yield* browserSessions.getPartition("scope-a", "account-a");
      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      const verify = browserSession.setCertificateVerifyProc.mock.calls[0]?.[0];
      assert.isFunction(verify);

      const trustedRoot = makeCertificate(trustedCaFingerprint);
      const trustedLeaf = makeCertificate("BB".repeat(32), trustedRoot);
      const foreignRoot = makeCertificate("CC".repeat(32));
      const foreignLeaf = makeCertificate("DD".repeat(32), foreignRoot);
      const resultFor = (
        certificate: Certificate,
        verificationResult: string,
        errorCode: number,
      ) => {
        let result: number | undefined;
        verify(
          {
            hostname: "example.test",
            certificate,
            validatedCertificate: certificate,
            isIssuedByKnownRoot: false,
            verificationResult,
            errorCode,
          },
          (value: number) => {
            result = value;
          },
        );
        return result;
      };

      assert.strictEqual(resultFor(trustedLeaf, "CERT_AUTHORITY_INVALID", -202), 0);
      assert.strictEqual(resultFor(foreignLeaf, "CERT_AUTHORITY_INVALID", -202), -3);
      assert.strictEqual(resultFor(trustedLeaf, "CERT_DATE_INVALID", -201), -3);
      assert.strictEqual(resultFor(trustedLeaf, "OK", 0), -3);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("verifies a proxy leaf signed by the configured CA when Chromium omits the root", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.configureProxy("scope-a", "account-a", {
        proxyUrl: "http://127.0.0.1:8080",
        caCertificatePem: trustedCaPem,
      });
      const partition = yield* browserSessions.getPartition("scope-a", "account-a");
      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      const verify = browserSession.setCertificateVerifyProc.mock.calls[0]?.[0];
      assert.isFunction(verify);

      const trustedLeaf = makeCertificate("BB".repeat(32), undefined, trustedLeafPem);
      const foreignLeaf = makeCertificate("CC".repeat(32), undefined, foreignLeafPem);
      const resultFor = (
        certificate: Certificate,
        verificationResult: string,
        errorCode: number,
      ) => {
        let result: number | undefined;
        verify(
          {
            hostname: "example.test",
            certificate,
            validatedCertificate: certificate,
            isIssuedByKnownRoot: false,
            verificationResult,
            errorCode,
          },
          (value: number) => {
            result = value;
          },
        );
        return result;
      };

      assert.strictEqual(resultFor(trustedLeaf, "CERT_AUTHORITY_INVALID", -202), 0);
      assert.strictEqual(resultFor(foreignLeaf, "CERT_AUTHORITY_INVALID", -202), -3);
      assert.strictEqual(resultFor(trustedLeaf, "CERT_DATE_INVALID", -201), -3);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears certificate verification and connections when proxying is disabled", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.configureProxy("scope-a", "account-a", {
        proxyUrl: "http://127.0.0.1:8080",
        caFingerprint: trustedCaFingerprint,
      });
      yield* browserSessions.configureProxy("scope-a", "account-a", null);

      const partition = yield* browserSessions.getPartition("scope-a", "account-a");
      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      assert.strictEqual(browserSession.setCertificateVerifyProc.mock.calls.at(-1)?.[0], null);
      assert.deepEqual(browserSession.setProxy.mock.calls.at(-1), [{ mode: "direct" }]);
      assert.strictEqual(browserSession.closeAllConnections.mock.calls.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects invalid proxy settings before creating a browser session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const error = yield* browserSessions
        .configureProxy("scope-a", "account-a", {
          proxyUrl: "https://127.0.0.1:8080",
          caFingerprint: trustedCaFingerprint,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionProxyValidationError);
      assert.strictEqual(fromPartition.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("grants clipboard-sanitized-write through both the request and check handlers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);

      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "notifications",
        "geolocation",
      ]) {
        assert.isTrue(requestAllows(permission), `request handler should allow ${permission}`);
        assert.isTrue(
          checkHandler(null, permission) as boolean,
          `check handler should allow ${permission}`,
        );
      }

      // `clipboard-write` is not a real Electron permission — the async write API
      // uses `clipboard-sanitized-write` — so the stale name must not be granted,
      // and unrelated permissions stay denied.
      for (const permission of ["clipboard-write", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves partition scope and the platform failure chain", () => {
    const nativeCause = new Error("native digest failed");
    const platformCause = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "digest",
      cause: nativeCause,
    });
    const failingCryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(platformCause),
      }),
    );

    return Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const error = yield* browserSessions.getPartition("environment-a").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionPartitionDerivationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-a");
      assert.strictEqual(error.cause, platformCause);
      assert.strictEqual(error.cause.reason.cause, nativeCause);
      assert.equal(
        error.message,
        "Failed to derive a desktop preview browser partition for scope environment-a.",
      );
      assert.notInclude(error.message, nativeCause.message);
    }).pipe(Effect.provide(BrowserSession.layer.pipe(Layer.provide(failingCryptoLayer))));
  });

  it.effect("preserves session scope, partition, and the Electron failure", () =>
    Effect.gen(function* () {
      const cause = new Error("Electron session failed");
      fromPartition.mockImplementationOnce(() => {
        throw cause;
      });
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("environment-b");
      const error = yield* browserSessions.getSession("environment-b").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionCreationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-b");
      assert.equal(error.partition, partition);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to create a desktop preview browser session for scope environment-b (partition ${partition}).`,
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears storage and cache for every created session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");

      yield* browserSessions.clearCookies();
      yield* browserSessions.clearCache();

      assert.strictEqual(sessions.size, 2);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
        assert.deepEqual(browserSession.clearStorageData.mock.calls[0], [
          {
            storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
          },
        ]);
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears stale proxy state and cache without deleting profile data", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "erebus-preview-cache-"));
        const partition = "persist:t3code-preview-stale";
        const partitionPath = NodePath.join(root, "Partitions", partition.slice("persist:".length));
        NodeFS.mkdirSync(partitionPath, { recursive: true });
        NodeFS.utimesSync(partitionPath, 0, 0);
        sessionDataPath.value = root;
        return { partition, root };
      }),
      ({ partition }) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("9 days");
          yield* BrowserSession.make.pipe(Effect.provide(NodeServices.layer));
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              const staleSession = sessions.get(partition);
              assert.isDefined(staleSession);
              assert.strictEqual(staleSession.clearCache.mock.calls.length, 1);
              assert.strictEqual(staleSession.clearStorageData.mock.calls.length, 0);
              assert.deepEqual(staleSession.setProxy.mock.calls, [[{ mode: "direct" }]]);
              assert.deepEqual(staleSession.setCertificateVerifyProc.mock.calls, [[null]]);
              assert.strictEqual(staleSession.closeAllConnections.mock.calls.length, 1);
              assert.strictEqual(staleSession.flushStorageData.mock.calls.length, 0);
            }),
          );
        }),
      ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    ),
  );

  it.effect("correlates clear failures while still attempting every session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");
      const firstPartition = yield* browserSessions.getPartition("scope-a");
      const secondPartition = yield* browserSessions.getPartition("scope-b");
      const firstSession = sessions.get(firstPartition);
      const secondSession = sessions.get(secondPartition);
      assert.isDefined(firstSession);
      assert.isDefined(secondSession);

      const storageCause = new Error("storage clear failed");
      secondSession.clearStorageData.mockImplementationOnce(() => Promise.reject(storageCause));
      const storageError = yield* browserSessions.clearCookies().pipe(Effect.flip);

      assert.instanceOf(storageError, BrowserSession.BrowserSessionStorageClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(storageError));
      assert.equal(storageError.partition, secondPartition);
      assert.strictEqual(storageError.cause, storageCause);
      assert.equal(
        storageError.message,
        `Failed to clear desktop preview browser storage for partition ${secondPartition}.`,
      );
      assert.notInclude(storageError.message, storageCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
      }

      const cacheCause = new Error("cache clear failed");
      firstSession.clearCache.mockImplementationOnce(() => Promise.reject(cacheCause));
      const cacheError = yield* browserSessions.clearCache().pipe(Effect.flip);

      assert.instanceOf(cacheError, BrowserSession.BrowserSessionCacheClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(cacheError));
      assert.equal(cacheError.partition, firstPartition);
      assert.strictEqual(cacheError.cause, cacheCause);
      assert.equal(
        cacheError.message,
        `Failed to clear the desktop preview browser cache for partition ${firstPartition}.`,
      );
      assert.notInclude(cacheError.message, cacheCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});
