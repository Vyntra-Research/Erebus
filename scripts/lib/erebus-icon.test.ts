import { describe, expect, it } from "@effect/vitest";

import { renderErebusIcon, renderIceWhiteErebusGlyph } from "./erebus-icon.ts";

function alphaAt(image: ReturnType<typeof renderErebusIcon>, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3]!;
}

describe("Erebus icon renderer", () => {
  it("renders a transparent, responsive ouroboros", () => {
    for (const size of [16, 24, 32, 48, 256, 1024]) {
      const image = renderErebusIcon(size);
      expect(image.width).toBe(size);
      expect(image.height).toBe(size);
      expect(alphaAt(image, 0, 0)).toBe(0);
      expect(alphaAt(image, Math.floor(size / 2), Math.floor(size * 0.8))).toBeGreaterThan(0);
    }
  });

  it("renders rounded and opaque off-white tiles", () => {
    const rounded = renderErebusIcon(128, "rounded");
    const square = renderErebusIcon(128, "square");
    expect(alphaAt(rounded, 0, 0)).toBe(0);
    expect(alphaAt(rounded, 64, 64)).toBe(255);
    expect(alphaAt(square, 0, 0)).toBe(255);
    expect(alphaAt(square, 127, 127)).toBe(255);
  });

  it("uses the light ouroboros on dark app tiles", () => {
    const rounded = renderErebusIcon(64, "rounded");
    const tileOffset = (32 * rounded.width + 32) * 4;
    const markOffset = (12 * rounded.width + 31) * 4;

    expect(rounded.data[tileOffset]).toBeLessThan(32);
    expect(rounded.data[markOffset]).toBeGreaterThan(220);
  });

  it("keeps the light glyph transparent", () => {
    const light = renderIceWhiteErebusGlyph(64);
    expect(alphaAt(light, 0, 0)).toBe(0);
    expect(alphaAt(light, 32, 51)).toBeGreaterThan(0);
  });
});
