import { useSyncExternalStore } from "react";

const DATABASE_NAME = "erebus-client-assets";
const DATABASE_VERSION = 1;
const STORE_NAME = "wallpaper";
const WALLPAPER_KEY = "current";
const MAX_WALLPAPER_BYTES = 32 * 1024 * 1024;
const MAX_WALLPAPER_PIXELS = 80_000_000;
const SUPPORTED_WALLPAPER_TYPES = new Set(["image/avif", "image/jpeg", "image/png", "image/webp"]);

interface StoredWallpaper {
  readonly blob: Blob;
  readonly fileName: string;
}

export interface WallpaperAssetSnapshot {
  readonly status: "loading" | "ready" | "error";
  readonly fileName: string | null;
  readonly url: string | null;
  readonly error: string | null;
}

const listeners = new Set<() => void>();
let snapshot: WallpaperAssetSnapshot = {
  status: "loading",
  fileName: null,
  url: null,
  error: null,
};
let hydration: Promise<void> | null = null;
let operationGeneration = 0;
let hydrated = false;

function emitChange() {
  for (const listener of listeners) listener();
}

function replaceSnapshot(next: WallpaperAssetSnapshot) {
  const previousUrl = snapshot.url;
  snapshot = next;
  emitChange();
  if (previousUrl && previousUrl !== next.url) URL.revokeObjectURL(previousUrl);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("The wallpaper database request failed.")),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("The wallpaper database transaction aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("The wallpaper database transaction failed.")),
      { once: true },
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Wallpaper storage is unavailable in this client."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener(
      "upgradeneeded",
      () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      },
      { once: true },
    );
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Could not open wallpaper storage.")),
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => reject(new Error("Wallpaper storage is busy in another window.")),
      { once: true },
    );
  });
}

function isStoredWallpaper(value: unknown): value is StoredWallpaper {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredWallpaper>;
  return candidate.blob instanceof Blob && typeof candidate.fileName === "string";
}

async function readStoredWallpaper(): Promise<StoredWallpaper | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = transactionComplete(transaction);
    const [value] = await Promise.all([
      requestResult(transaction.objectStore(STORE_NAME).get(WALLPAPER_KEY)),
      completed,
    ]);
    return isStoredWallpaper(value) ? value : null;
  } finally {
    database.close();
  }
}

async function writeStoredWallpaper(wallpaper: StoredWallpaper): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(STORE_NAME).put(wallpaper, WALLPAPER_KEY);
    await completed;
  } finally {
    database.close();
  }
}

async function deleteStoredWallpaper(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(STORE_NAME).delete(WALLPAPER_KEY);
    await completed;
  } finally {
    database.close();
  }
}

async function hydrateWallpaper(): Promise<void> {
  if (hydrated) return;
  if (hydration) return hydration;
  const generation = operationGeneration;
  const pending = (async () => {
    try {
      const stored = await readStoredWallpaper();
      if (generation !== operationGeneration) return;
      replaceSnapshot({
        status: "ready",
        fileName: stored?.fileName ?? null,
        url: stored ? URL.createObjectURL(stored.blob) : null,
        error: null,
      });
    } catch (error) {
      if (generation !== operationGeneration) return;
      replaceSnapshot({
        status: "error",
        fileName: null,
        url: null,
        error: error instanceof Error ? error.message : "Could not load the wallpaper.",
      });
    } finally {
      if (generation === operationGeneration) hydrated = true;
    }
  })();
  const hydrationPromise = pending.finally(() => {
    if (hydration === hydrationPromise) hydration = null;
  });
  hydration = hydrationPromise;
  return hydration;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void hydrateWallpaper();
  return () => listeners.delete(listener);
}

export function getWallpaperValidationError(file: File): string | null {
  if (!SUPPORTED_WALLPAPER_TYPES.has(file.type)) {
    return "Choose a PNG, JPEG, WebP, or AVIF image.";
  }
  if (file.size === 0) return "The selected image is empty.";
  if (file.size > MAX_WALLPAPER_BYTES) return "Choose an image smaller than 32 MB.";
  return null;
}

export async function setWallpaperAsset(file: File): Promise<void> {
  const validationError = getWallpaperValidationError(file);
  if (validationError) throw new Error(validationError);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("The selected image could not be decoded.");
  }
  try {
    if (bitmap.width * bitmap.height > MAX_WALLPAPER_PIXELS) {
      throw new Error("Choose an image smaller than 80 megapixels.");
    }
  } finally {
    bitmap.close();
  }

  operationGeneration += 1;
  try {
    await writeStoredWallpaper({ blob: file, fileName: file.name });
    hydrated = true;
    replaceSnapshot({
      status: "ready",
      fileName: file.name,
      url: URL.createObjectURL(file),
      error: null,
    });
  } catch (error) {
    hydrated = true;
    replaceSnapshot({
      ...snapshot,
      status: "error",
      error: error instanceof Error ? error.message : "Could not save the wallpaper.",
    });
    throw error;
  }
}

export async function clearWallpaperAsset(): Promise<void> {
  operationGeneration += 1;
  try {
    await deleteStoredWallpaper();
    hydrated = true;
    replaceSnapshot({ status: "ready", fileName: null, url: null, error: null });
  } catch (error) {
    hydrated = true;
    replaceSnapshot({
      ...snapshot,
      status: "error",
      error: error instanceof Error ? error.message : "Could not remove the wallpaper.",
    });
    throw error;
  }
}

export function useWallpaperAsset(): WallpaperAssetSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
