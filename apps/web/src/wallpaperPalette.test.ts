import { describe, expect, it } from "vite-plus/test";

import { deriveWallpaperPaletteSeeds } from "./wallpaperPalette";

function pixels(colors: ReadonlyArray<readonly [number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flatMap(([r, g, b]) => [r, g, b, 255]));
}

describe("deriveWallpaperPaletteSeeds", () => {
  it("keeps a vivid minority color as the accent", () => {
    const sample = pixels([
      ...Array.from({ length: 12 }, () => [18, 20, 24] as const),
      ...Array.from({ length: 4 }, () => [210, 38, 48] as const),
      ...Array.from({ length: 2 }, () => [116, 20, 30] as const),
    ]);

    const palette = deriveWallpaperPaletteSeeds(sample, "dark");

    expect(palette.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(Number.parseInt(palette.accent.slice(1, 3), 16)).toBeGreaterThan(
      Number.parseInt(palette.accent.slice(3, 5), 16),
    );
  });

  it("does not inflate a weak olive cast into a saturated green accent", () => {
    const sample = pixels([
      ...Array.from({ length: 120 }, () => [20, 20, 20] as const),
      ...Array.from({ length: 30 }, () => [104, 106, 96] as const),
      ...Array.from({ length: 3 }, () => [190, 28, 42] as const),
    ]);

    const palette = deriveWallpaperPaletteSeeds(sample, "dark");
    const red = Number.parseInt(palette.accent.slice(1, 3), 16);
    const green = Number.parseInt(palette.accent.slice(3, 5), 16);

    expect(red).toBeGreaterThan(green * 1.5);
  });

  it("keeps a monochrome wallpaper palette neutral", () => {
    const sample = pixels([
      ...Array.from({ length: 80 }, () => [18, 18, 18] as const),
      ...Array.from({ length: 20 }, () => [118, 121, 116] as const),
    ]);

    const palette = deriveWallpaperPaletteSeeds(sample, "dark");
    const channels = [1, 3, 5].map((offset) =>
      Number.parseInt(palette.accent.slice(offset, offset + 2), 16),
    );

    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(20);
  });

  it("derives a light canvas for light appearance", () => {
    const palette = deriveWallpaperPaletteSeeds(pixels([[30, 70, 120]]), "light");
    const red = Number.parseInt(palette.background.slice(1, 3), 16);
    const green = Number.parseInt(palette.background.slice(3, 5), 16);
    const blue = Number.parseInt(palette.background.slice(5, 7), 16);

    expect((red + green + blue) / 3).toBeGreaterThan(210);
  });

  it("falls back safely when the image has no visible pixels", () => {
    expect(deriveWallpaperPaletteSeeds(new Uint8ClampedArray([0, 0, 0, 0]), "dark")).toEqual({
      background: "#111111",
      accent: "#7aa2f7",
      swatches: ["#111111", "#7aa2f7"],
    });
  });
});
