import { useEffect, useState } from "react";

import { createVividThemeColors, type ThemeAppearance, type ThemeColors } from "./themePalette";

const SAMPLE_EDGE = 160;
const MAX_CACHE_ENTRIES = 4;
const PALETTE_VERSION = 4;

type Rgb = Readonly<{ r: number; g: number; b: number }>;
type Hsl = Readonly<{ h: number; s: number; l: number }>;
type ColorBucket = {
  count: number;
  r: number;
  g: number;
  b: number;
};

export type WallpaperPaletteSeeds = Readonly<{
  background: string;
  accent: string;
  swatches: ReadonlyArray<string>;
}>;

export type WallpaperPalette = WallpaperPaletteSeeds &
  Readonly<{
    colors: ThemeColors;
  }>;

type WallpaperPaletteState =
  | Readonly<{ status: "idle" | "loading"; palette: null; error: null }>
  | Readonly<{ status: "ready"; palette: WallpaperPalette; error: null }>
  | Readonly<{ status: "error"; palette: null; error: string }>;

const paletteCache = new Map<string, Promise<WallpaperPalette>>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(clamp(channel, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { h: 0, s: 0, l: lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  return { h: hue < 0 ? hue + 360 : hue, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (section < 1) [red, green] = [chroma, x];
  else if (section < 2) [red, green] = [x, chroma];
  else if (section < 3) [green, blue] = [chroma, x];
  else if (section < 4) [green, blue] = [x, chroma];
  else if (section < 5) [red, blue] = [x, chroma];
  else [red, blue] = [chroma, x];
  const match = l - chroma / 2;
  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

function colorDistance(first: Rgb, second: Rgb): number {
  const red = first.r - second.r;
  const green = first.g - second.g;
  const blue = first.b - second.b;
  return Math.sqrt(red * red + green * green + blue * blue) / 441.67;
}

function bucketColor(bucket: ColorBucket): Rgb {
  return {
    r: bucket.r / bucket.count,
    g: bucket.g / bucket.count,
    b: bucket.b / bucket.count,
  };
}

function collectBuckets(pixels: Uint8ClampedArray): ReadonlyArray<ColorBucket> {
  const buckets = new Map<number, ColorBucket>();
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    const r = pixels[index]!;
    const g = pixels[index + 1]!;
    const b = pixels[index + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }
  return [...buckets.values()].sort((first, second) => second.count - first.count);
}

function selectAccent(buckets: ReadonlyArray<ColorBucket>, dominant: Rgb): Rgb {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const minimumChromaticCount = Math.max(1, Math.floor(total * 0.00025));
  const chromatic = buckets.filter((bucket) => {
    const { s, l } = rgbToHsl(bucketColor(bucket));
    return bucket.count >= minimumChromaticCount && s >= 0.28 && l >= 0.08 && l <= 0.92;
  });
  const candidates = chromatic.length > 0 ? chromatic : buckets;
  let best = dominant;
  let bestScore = -1;
  for (const bucket of candidates) {
    const color = bucketColor(bucket);
    const { s, l } = rgbToHsl(color);
    const population = Math.log2(bucket.count + 1) / Math.log2(Math.max(2, total + 1));
    const usableLightness = 1 - Math.min(1, Math.abs(l - 0.52) * 1.7);
    const score =
      (0.35 + population * 0.65) *
      (chromatic.length > 0 ? s * s : 0.2 + s) *
      (0.55 + colorDistance(color, dominant)) *
      (0.55 + usableLightness * 0.45);
    if (score > bestScore) {
      best = color;
      bestScore = score;
    }
  }
  return best;
}

function makeBackground(dominant: Rgb, accent: Rgb, appearance: ThemeAppearance): Rgb {
  const dominantHsl = rgbToHsl(dominant);
  const source =
    dominantHsl.s < 0.1
      ? {
          r: dominant.r * 0.92 + accent.r * 0.08,
          g: dominant.g * 0.92 + accent.g * 0.08,
          b: dominant.b * 0.92 + accent.b * 0.08,
        }
      : dominant;
  const target = appearance === "dark" ? 0 : 255;
  const sourceWeight = appearance === "dark" ? 0.22 : 0.14;
  return {
    r: target * (1 - sourceWeight) + source.r * sourceWeight,
    g: target * (1 - sourceWeight) + source.g * sourceWeight,
    b: target * (1 - sourceWeight) + source.b * sourceWeight,
  };
}

function makeAccent(color: Rgb, appearance: ThemeAppearance): Rgb {
  const hsl = rgbToHsl(color);
  const saturation = hsl.s < 0.16 ? hsl.s : clamp(hsl.s * 1.08, 0.38, 0.82);
  return hslToRgb({
    h: hsl.h,
    s: saturation,
    l: appearance === "dark" ? clamp(hsl.l, 0.58, 0.72) : clamp(hsl.l, 0.38, 0.54),
  });
}

export function deriveWallpaperPaletteSeeds(
  pixels: Uint8ClampedArray,
  appearance: ThemeAppearance,
): WallpaperPaletteSeeds {
  const buckets = collectBuckets(pixels);
  if (buckets.length === 0) {
    const background = appearance === "dark" ? "#111111" : "#f7f7f7";
    const accent = appearance === "dark" ? "#7aa2f7" : "#315fbe";
    return { background, accent, swatches: [background, accent] };
  }

  const dominant = bucketColor(buckets[0]!);
  const accentSource = selectAccent(buckets, dominant);
  const background = rgbToHex(makeBackground(dominant, accentSource, appearance));
  const accent = rgbToHex(makeAccent(accentSource, appearance));
  const swatches = buckets
    .slice(0, 24)
    .map(bucketColor)
    .filter((color, index, colors) =>
      colors.slice(0, index).every((previous) => colorDistance(color, previous) >= 0.12),
    )
    .slice(0, 6)
    .map(rgbToHex);

  return { background, accent, swatches: swatches.length >= 2 ? swatches : [background, accent] };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Could not read wallpaper colors.")), {
      once: true,
    });
    image.src = url;
  });
}

async function generateWallpaperPalette(
  url: string,
  appearance: ThemeAppearance,
): Promise<WallpaperPalette> {
  const image = await loadImage(url);
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("Wallpaper color sampling is unavailable.");
  context.drawImage(image, 0, 0, width, height);
  const seeds = deriveWallpaperPaletteSeeds(
    context.getImageData(0, 0, width, height).data,
    appearance,
  );
  const colors = createVividThemeColors(appearance, seeds.background, seeds.accent);
  return {
    ...seeds,
    colors: {
      ...colors,
      sidebar: colors.canvas,
      sidebarControlSurface: colors.surface,
      sidebarRowHover: colors.surface,
      sidebarRowActive: colors.surfaceRaised,
      sidebarRowSelected: colors.surfaceRaised,
      sidebarBorder: colors.border,
      messageSurface: colors.canvas,
      messageForeground: colors.text,
    },
  };
}

function getWallpaperPalette(url: string, appearance: ThemeAppearance): Promise<WallpaperPalette> {
  const key = `${PALETTE_VERSION}:${appearance}:${url}`;
  const existing = paletteCache.get(key);
  if (existing) return existing;
  const palette = generateWallpaperPalette(url, appearance).catch((error) => {
    paletteCache.delete(key);
    throw error;
  });
  paletteCache.set(key, palette);
  if (paletteCache.size > MAX_CACHE_ENTRIES) {
    const oldest = paletteCache.keys().next().value as string | undefined;
    if (oldest) paletteCache.delete(oldest);
  }
  return palette;
}

export function useWallpaperPalette(
  url: string | null,
  appearance: ThemeAppearance,
): WallpaperPaletteState {
  const key = url ? `${PALETTE_VERSION}:${appearance}:${url}` : null;
  const [state, setState] = useState<WallpaperPaletteState & { readonly key: string | null }>(
    () => ({
      key,
      status: url ? "loading" : "idle",
      palette: null,
      error: null,
    }),
  );

  useEffect(() => {
    if (!url || !key) {
      setState({ key: null, status: "idle", palette: null, error: null });
      return;
    }
    let active = true;
    setState({ key, status: "loading", palette: null, error: null });
    void getWallpaperPalette(url, appearance).then(
      (palette) => {
        if (active) setState({ key, status: "ready", palette, error: null });
      },
      (error: unknown) => {
        if (active) {
          setState({
            key,
            status: "error",
            palette: null,
            error: error instanceof Error ? error.message : "Could not generate wallpaper colors.",
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [appearance, key, url]);

  if (state.key !== key) {
    return { status: url ? "loading" : "idle", palette: null, error: null };
  }
  return state;
}
