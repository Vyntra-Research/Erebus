import { describe, expect, it } from "@effect/vitest";

import { renderErebusIcon, renderIceWhiteErebusGlyph } from "./erebus-icon.ts";

function alphaAt(image: ReturnType<typeof renderErebusIcon>, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3]!;
}

describe("Erebus icon renderer", () => {
  it("renders a transparent, responsive monolith", () => {
    for (const size of [16, 24, 32, 48, 256, 1024]) {
      const image = renderErebusIcon(size);
      expect(image.width).toBe(size);
      expect(image.height).toBe(size);
      expect(alphaAt(image, 0, 0)).toBe(0);
      expect(alphaAt(image, Math.floor(size / 2), Math.floor(size / 2))).toBeGreaterThan(0);
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

  it("keeps the light glyph transparent", () => {
    const light = renderIceWhiteErebusGlyph(64);
    expect(alphaAt(light, 0, 0)).toBe(0);
    expect(alphaAt(light, 32, 32)).toBeGreaterThan(0);
  });
});
