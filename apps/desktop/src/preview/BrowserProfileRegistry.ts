import {
  DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  DesktopPreviewBrowserProfileSchema,
  type DesktopPreviewBrowserProfile,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const REGISTRY_FILE_NAME = "browser-profiles.json";
const DEFAULT_PROFILE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const PARTITION_PATTERN = /^persist:t3code-preview-[0-9a-f]{20}$/;

const StoredBrowserProfileSchema = Schema.Struct({
  ...DesktopPreviewBrowserProfileSchema.fields,
  isDefault: Schema.Literal(false),
  partitions: Schema.Array(Schema.String),
});

const BrowserProfilePartitionOwnerSchema = Schema.Struct({
  profileId: DesktopPreviewBrowserProfileSchema.fields.id,
  partition: Schema.String,
  environmentId: Schema.String,
});

const BrowserProfileDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  defaultPartitions: Schema.optionalKey(Schema.Array(Schema.String)),
  partitionOwners: Schema.optionalKey(Schema.Array(BrowserProfilePartitionOwnerSchema)),
  profiles: Schema.Array(StoredBrowserProfileSchema),
});

type StoredBrowserProfile = typeof StoredBrowserProfileSchema.Type;
type BrowserProfilePartitionOwner = typeof BrowserProfilePartitionOwnerSchema.Type;
type BrowserProfileDocument = Omit<
  typeof BrowserProfileDocumentSchema.Type,
  "defaultPartitions" | "partitionOwners"
> & {
  readonly defaultPartitions: ReadonlyArray<string>;
  readonly partitionOwners: ReadonlyArray<BrowserProfilePartitionOwner>;
};

const BrowserProfileDocumentJson = Schema.fromJsonString(BrowserProfileDocumentSchema);
const decodeDocument = Schema.decodeEffect(BrowserProfileDocumentJson);
const encodeDocument = Schema.encodeEffect(BrowserProfileDocumentJson);

export const DEFAULT_BROWSER_PROFILE: DesktopPreviewBrowserProfile = {
  id: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  name: "Default",
  isDefault: true,
  createdAt: DEFAULT_PROFILE_TIMESTAMP,
  updatedAt: DEFAULT_PROFILE_TIMESTAMP,
};

export function normalizeBrowserProfileName(name: string): string {
  return name.trim().replace(/\s+/gu, " ");
}

export class BrowserProfileNameInvalidError extends Schema.TaggedErrorClass<BrowserProfileNameInvalidError>()(
  "BrowserProfileNameInvalidError",
  { name: Schema.String },
) {
  override get message(): string {
    return "Browser profile names must contain between 1 and 80 characters.";
  }
}

export class BrowserProfileNameConflictError extends Schema.TaggedErrorClass<BrowserProfileNameConflictError>()(
  "BrowserProfileNameConflictError",
  { name: Schema.String },
) {
  override get message(): string {
    return `A browser profile named ${JSON.stringify(this.name)} already exists.`;
  }
}

export class BrowserProfileNotFoundError extends Schema.TaggedErrorClass<BrowserProfileNotFoundError>()(
  "BrowserProfileNotFoundError",
  { profileId: Schema.String },
) {
  override get message(): string {
    return `Browser profile ${this.profileId} does not exist.`;
  }
}

export class DefaultBrowserProfileImmutableError extends Schema.TaggedErrorClass<DefaultBrowserProfileImmutableError>()(
  "DefaultBrowserProfileImmutableError",
  {},
) {
  override get message(): string {
    return "The default browser profile cannot be renamed or deleted.";
  }
}

const BrowserProfileWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-registry-file",
]);

export class BrowserProfileRegistryWriteError extends Schema.TaggedErrorClass<BrowserProfileRegistryWriteError>()(
  "BrowserProfileRegistryWriteError",
  {
    operation: BrowserProfileWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser profile registry write failed during ${this.operation} at ${this.path}.`;
  }
}

export const BrowserProfileRegistryError = Schema.Union([
  BrowserProfileNameInvalidError,
  BrowserProfileNameConflictError,
  BrowserProfileNotFoundError,
  DefaultBrowserProfileImmutableError,
  BrowserProfileRegistryWriteError,
]);
export type BrowserProfileRegistryError = typeof BrowserProfileRegistryError.Type;

function publicProfile(profile: StoredBrowserProfile): DesktopPreviewBrowserProfile {
  const { partitions: _partitions, ...visible } = profile;
  return visible;
}

function compareProfileNames(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function validateName(name: string): Effect.Effect<string, BrowserProfileNameInvalidError> {
  const normalized = normalizeBrowserProfileName(name);
  return normalized.length > 0 && normalized.length <= 80
    ? Effect.succeed(normalized)
    : Effect.fail(new BrowserProfileNameInvalidError({ name }));
}

function validateDocument(
  document: typeof BrowserProfileDocumentSchema.Type,
): BrowserProfileDocument | null {
  const ids = new Set<string>();
  const names: string[] = [DEFAULT_BROWSER_PROFILE.name];
  const defaultPartitions = document.defaultPartitions ?? [];
  const partitionOwners = document.partitionOwners ?? [];
  if (defaultPartitions.some((partition) => !PARTITION_PATTERN.test(partition))) return null;
  for (const profile of document.profiles) {
    if (
      profile.id === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID ||
      ids.has(profile.id) ||
      normalizeBrowserProfileName(profile.name) !== profile.name ||
      profile.name.length === 0 ||
      profile.name.length > 80 ||
      names.some((name) => compareProfileNames(name, profile.name)) ||
      profile.partitions.some((partition) => !PARTITION_PATTERN.test(partition))
    ) {
      return null;
    }
    ids.add(profile.id);
    names.push(profile.name);
  }
  if (
    partitionOwners.some(
      ({ profileId, partition, environmentId }) =>
        !PARTITION_PATTERN.test(partition) ||
        environmentId.trim() === "" ||
        (profileId !== DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID && !ids.has(profileId)),
    )
  ) {
    return null;
  }
  return { ...document, defaultPartitions, partitionOwners };
}

const readDocument = Effect.fn("BrowserProfileRegistry.readDocument")(function* (
  fileSystem: FileSystem.FileSystem,
  registryPath: string,
) {
  const raw = yield* fileSystem.readFileString(registryPath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Could not read the browser profile registry.", cause).pipe(
              Effect.annotateLogs({ registryPath }),
              Effect.as(Option.none<string>()),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return {
      version: 1,
      defaultPartitions: [],
      partitionOwners: [],
      profiles: [],
    } satisfies BrowserProfileDocument;
  }

  return yield* decodeDocument(raw.value).pipe(
    Effect.map(validateDocument),
    Effect.flatMap((document) =>
      document === null
        ? Effect.logWarning("Ignored an invalid browser profile registry.", { registryPath }).pipe(
            Effect.as({
              version: 1,
              defaultPartitions: [],
              partitionOwners: [],
              profiles: [],
            } satisfies BrowserProfileDocument),
          )
        : Effect.succeed(document),
    ),
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.logWarning("Could not decode the browser profile registry.", cause).pipe(
          Effect.annotateLogs({ registryPath }),
          Effect.as({
            version: 1,
            defaultPartitions: [],
            partitionOwners: [],
            profiles: [],
          } satisfies BrowserProfileDocument),
        ),
    }),
  );
});

const writeDocument = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly registryPath: string;
  readonly document: BrowserProfileDocument;
}): Effect.fn.Return<void, BrowserProfileRegistryWriteError> {
  const suffix = yield* input.crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => uuid.replaceAll("-", "")),
    Effect.mapError(
      (cause) =>
        new BrowserProfileRegistryWriteError({
          operation: "create-temporary-file-name",
          path: input.registryPath,
          cause,
        }),
    ),
  );
  const directory = input.path.dirname(input.registryPath);
  const tempPath = `${input.registryPath}.${process.pid}.${suffix}.tmp`;
  const encoded = yield* encodeDocument(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserProfileRegistryWriteError({
          operation: "encode-document",
          path: input.registryPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserProfileRegistryWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserProfileRegistryWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, input.registryPath).pipe(
    Effect.mapError(
      (cause) =>
        new BrowserProfileRegistryWriteError({
          operation: "replace-registry-file",
          path: input.registryPath,
          cause,
        }),
    ),
    Effect.ensuring(input.fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
  );
});

export class BrowserProfileRegistry extends Context.Service<
  BrowserProfileRegistry,
  {
    readonly list: Effect.Effect<readonly DesktopPreviewBrowserProfile[]>;
    readonly assertExists: (
      profileId: string | undefined,
    ) => Effect.Effect<void, BrowserProfileNotFoundError>;
    readonly create: (
      name: string,
    ) => Effect.Effect<DesktopPreviewBrowserProfile, BrowserProfileRegistryError>;
    readonly rename: (
      profileId: string,
      name: string,
    ) => Effect.Effect<void, BrowserProfileRegistryError>;
    readonly recordPartition: (
      profileId: string,
      partition: string,
      environmentId: string,
    ) => Effect.Effect<void, BrowserProfileRegistryError>;
    readonly partitions: (
      profileId: string,
    ) => Effect.Effect<readonly string[], BrowserProfileNotFoundError>;
    readonly environmentPartitions: (
      environmentId: string,
    ) => Effect.Effect<readonly BrowserProfilePartitionOwner[]>;
    readonly unownedPartitions: Effect.Effect<
      readonly { readonly profileId: string; readonly partition: string }[]
    >;
    readonly removeEnvironment: (
      environmentId: string,
    ) => Effect.Effect<void, BrowserProfileRegistryWriteError>;
    readonly remove: (profileId: string) => Effect.Effect<void, BrowserProfileRegistryError>;
  }
>()("@t3tools/desktop/preview/BrowserProfileRegistry") {}

export const make = Effect.gen(function* BrowserProfileRegistryMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const registryPath = path.join(environment.stateDir, REGISTRY_FILE_NAME);
  const documentRef = yield* SynchronizedRef.make(yield* readDocument(fileSystem, registryPath));

  const persist = (document: BrowserProfileDocument) =>
    writeDocument({ fileSystem, path, crypto, registryPath, document });

  const assertExists = Effect.fn("BrowserProfileRegistry.assertExists")(function* (
    profileId?: string,
  ) {
    if (profileId === undefined || profileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID) {
      return;
    }
    const document = yield* SynchronizedRef.get(documentRef);
    if (!document.profiles.some((profile) => profile.id === profileId)) {
      return yield* new BrowserProfileNotFoundError({ profileId });
    }
  });

  return BrowserProfileRegistry.of({
    list: SynchronizedRef.get(documentRef).pipe(
      Effect.map((document) => [
        DEFAULT_BROWSER_PROFILE,
        ...document.profiles
          .map(publicProfile)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      ]),
    ),
    assertExists,
    create: Effect.fn("BrowserProfileRegistry.create")(function* (rawName) {
      const name = yield* validateName(rawName);
      const profileId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new BrowserProfileRegistryWriteError({
              operation: "create-temporary-file-name",
              path: registryPath,
              cause,
            }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      const profile: StoredBrowserProfile = {
        id: profileId,
        name,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
        partitions: [],
      };
      yield* SynchronizedRef.modifyEffect(
        documentRef,
        (
          document,
        ): Effect.Effect<
          readonly [void, BrowserProfileDocument],
          BrowserProfileNameConflictError | BrowserProfileRegistryWriteError
        > => {
          if (
            [DEFAULT_BROWSER_PROFILE.name, ...document.profiles.map((entry) => entry.name)].some(
              (existing) => compareProfileNames(existing, name),
            )
          ) {
            return Effect.fail(new BrowserProfileNameConflictError({ name }));
          }
          const next = { ...document, profiles: [...document.profiles, profile] };
          return persist(next).pipe(Effect.as([undefined, next] as const));
        },
      );
      return publicProfile(profile);
    }),
    rename: Effect.fn("BrowserProfileRegistry.rename")(function* (profileId, rawName) {
      if (profileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID) {
        return yield* new DefaultBrowserProfileImmutableError();
      }
      const name = yield* validateName(rawName);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* SynchronizedRef.modifyEffect(
        documentRef,
        (
          document,
        ): Effect.Effect<
          readonly [void, BrowserProfileDocument],
          | BrowserProfileNameConflictError
          | BrowserProfileNotFoundError
          | BrowserProfileRegistryWriteError
        > => {
          const index = document.profiles.findIndex((profile) => profile.id === profileId);
          if (index < 0) return Effect.fail(new BrowserProfileNotFoundError({ profileId }));
          if (
            [
              DEFAULT_BROWSER_PROFILE.name,
              ...document.profiles.map((profile) => profile.name),
            ].some(
              (existing, existingIndex) =>
                existingIndex !== index + 1 && compareProfileNames(existing, name),
            )
          ) {
            return Effect.fail(new BrowserProfileNameConflictError({ name }));
          }
          if (document.profiles[index]!.name === name) {
            return Effect.succeed([undefined, document] as const);
          }
          const profiles = [...document.profiles];
          profiles[index] = { ...profiles[index]!, name, updatedAt: now };
          const next = { ...document, profiles };
          return persist(next).pipe(Effect.as([undefined, next] as const));
        },
      );
    }),
    recordPartition: Effect.fn("BrowserProfileRegistry.recordPartition")(
      function* (profileId, partition, environmentId) {
        if (!PARTITION_PATTERN.test(partition) || environmentId.trim() === "") {
          return yield* new BrowserProfileRegistryWriteError({
            operation: "encode-document",
            path: registryPath,
            cause: new TypeError("Invalid preview partition identifier."),
          });
        }
        yield* SynchronizedRef.modifyEffect(
          documentRef,
          (
            document,
          ): Effect.Effect<
            readonly [void, BrowserProfileDocument],
            BrowserProfileNotFoundError | BrowserProfileRegistryWriteError
          > => {
            const ownerExists = document.partitionOwners.some(
              (owner) =>
                owner.profileId === profileId &&
                owner.partition === partition &&
                owner.environmentId === environmentId,
            );
            const partitionOwners = ownerExists
              ? document.partitionOwners
              : [...document.partitionOwners, { profileId, partition, environmentId }];
            if (profileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID) {
              if (document.defaultPartitions.includes(partition) && ownerExists) {
                return Effect.succeed([undefined, document] as const);
              }
              const next = {
                ...document,
                defaultPartitions: document.defaultPartitions.includes(partition)
                  ? document.defaultPartitions
                  : [...document.defaultPartitions, partition],
                partitionOwners,
              };
              return persist(next).pipe(Effect.as([undefined, next] as const));
            }

            const index = document.profiles.findIndex((profile) => profile.id === profileId);
            if (index < 0) return Effect.fail(new BrowserProfileNotFoundError({ profileId }));
            const current = document.profiles[index]!;
            if (current.partitions.includes(partition) && ownerExists) {
              return Effect.succeed([undefined, document] as const);
            }
            const profiles = [...document.profiles];
            profiles[index] = {
              ...current,
              partitions: current.partitions.includes(partition)
                ? current.partitions
                : [...current.partitions, partition],
            };
            const next = { ...document, profiles, partitionOwners };
            return persist(next).pipe(Effect.as([undefined, next] as const));
          },
        );
      },
    ),
    partitions: Effect.fn("BrowserProfileRegistry.partitions")(function* (profileId) {
      if (profileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID) {
        return (yield* SynchronizedRef.get(documentRef)).defaultPartitions;
      }
      const document = yield* SynchronizedRef.get(documentRef);
      const profile = document.profiles.find((entry) => entry.id === profileId);
      if (profile === undefined) return yield* new BrowserProfileNotFoundError({ profileId });
      return profile.partitions;
    }),
    environmentPartitions: Effect.fn("BrowserProfileRegistry.environmentPartitions")(
      function* (environmentId) {
        const document = yield* SynchronizedRef.get(documentRef);
        return document.partitionOwners.filter((owner) => owner.environmentId === environmentId);
      },
    ),
    unownedPartitions: SynchronizedRef.get(documentRef).pipe(
      Effect.map((document) => {
        const owned = new Set(
          document.partitionOwners.map((owner) => `${owner.profileId}\u0000${owner.partition}`),
        );
        return [
          ...document.defaultPartitions.map((partition) => ({
            profileId: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
            partition,
          })),
          ...document.profiles.flatMap((profile) =>
            profile.partitions.map((partition) => ({ profileId: profile.id, partition })),
          ),
        ].filter(({ profileId, partition }) => !owned.has(`${profileId}\u0000${partition}`));
      }),
    ),
    removeEnvironment: Effect.fn("BrowserProfileRegistry.removeEnvironment")(
      function* (environmentId) {
        yield* SynchronizedRef.modifyEffect(
          documentRef,
          (
            document,
          ): Effect.Effect<
            readonly [void, BrowserProfileDocument],
            BrowserProfileRegistryWriteError
          > => {
            const removedOwners = document.partitionOwners.filter(
              (owner) => owner.environmentId === environmentId,
            );
            if (removedOwners.length === 0) {
              return Effect.succeed([undefined, document] as const);
            }
            const partitionOwners = document.partitionOwners.filter(
              (owner) => owner.environmentId !== environmentId,
            );
            const stillOwned = (profileId: string, partition: string) =>
              partitionOwners.some(
                (owner) => owner.profileId === profileId && owner.partition === partition,
              );
            const removedByProfile = new Map<string, Set<string>>();
            for (const owner of removedOwners) {
              const partitions = removedByProfile.get(owner.profileId) ?? new Set<string>();
              partitions.add(owner.partition);
              removedByProfile.set(owner.profileId, partitions);
            }
            const removedDefaults =
              removedByProfile.get(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID) ?? new Set<string>();
            const next = {
              ...document,
              defaultPartitions: document.defaultPartitions.filter(
                (partition) =>
                  !removedDefaults.has(partition) ||
                  stillOwned(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID, partition),
              ),
              partitionOwners,
              profiles: document.profiles.map((profile) => {
                const removed = removedByProfile.get(profile.id);
                if (removed === undefined) return profile;
                return {
                  ...profile,
                  partitions: profile.partitions.filter(
                    (partition) => !removed.has(partition) || stillOwned(profile.id, partition),
                  ),
                };
              }),
            };
            return persist(next).pipe(Effect.as([undefined, next] as const));
          },
        );
      },
    ),
    remove: Effect.fn("BrowserProfileRegistry.remove")(function* (profileId) {
      if (profileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID) {
        return yield* new DefaultBrowserProfileImmutableError();
      }
      yield* SynchronizedRef.modifyEffect(
        documentRef,
        (
          document,
        ): Effect.Effect<
          readonly [void, BrowserProfileDocument],
          BrowserProfileNotFoundError | BrowserProfileRegistryWriteError
        > => {
          if (!document.profiles.some((profile) => profile.id === profileId)) {
            return Effect.fail(new BrowserProfileNotFoundError({ profileId }));
          }
          const next = {
            ...document,
            profiles: document.profiles.filter((profile) => profile.id !== profileId),
            partitionOwners: document.partitionOwners.filter(
              (owner) => owner.profileId !== profileId,
            ),
          };
          return persist(next).pipe(Effect.as([undefined, next] as const));
        },
      );
    }),
  });
});

export const layer = Layer.effect(BrowserProfileRegistry, make);
