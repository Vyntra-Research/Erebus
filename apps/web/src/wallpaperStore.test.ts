import { describe, expect, it } from "vite-plus/test";

import { getWallpaperValidationError } from "./wallpaperStore";

function wallpaperFile(type: string, size: number): File {
  return { type, size } as File;
}

describe("wallpaper validation", () => {
  it.each(["image/avif", "image/jpeg", "image/png", "image/webp"])("accepts %s", (type) => {
    expect(getWallpaperValidationError(wallpaperFile(type, 1024))).toBeNull();
  });

  it("rejects animated, empty, and oversized files", () => {
    expect(getWallpaperValidationError(wallpaperFile("image/gif", 1024))).toContain("PNG");
    expect(getWallpaperValidationError(wallpaperFile("image/png", 0))).toContain("empty");
    expect(getWallpaperValidationError(wallpaperFile("image/png", 33 * 1024 * 1024))).toContain(
      "32 MB",
    );
  });
});
