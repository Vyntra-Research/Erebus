import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PNG } from "pngjs";

import { renderErebusIcon, renderIceWhiteErebusGlyph } from "./lib/erebus-icon.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const OUTPUT_SIZE = 1024;

function assertTransparentCanvas(image: PNG, label: string): void {
  const cornerOffsets = [
    3,
    (image.width - 1) * 4 + 3,
    (image.height - 1) * image.width * 4 + 3,
    (image.height * image.width - 1) * 4 + 3,
  ];
  if (cornerOffsets.some((offset) => image.data[offset] !== 0)) {
    throw new Error(`${label} must have fully transparent corners.`);
  }

  let transparentPixels = 0;
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset] === 0) transparentPixels++;
  }
  const pixelCount = image.width * image.height;
  if (transparentPixels < pixelCount * 0.05) {
    throw new Error(`${label} must contain a real transparent canvas.`);
  }
}

function encodePng(image: PNG, opaque = false): Buffer {
  return PNG.sync.write(
    image,
    opaque
      ? { bitDepth: 8, colorType: 2, inputColorType: 6, inputHasAlpha: true }
      : { colorType: 6 },
  );
}

const writePng = Effect.fn("writeErebusIconPng")(function* (
  filePath: string,
  image: PNG,
  opaque = false,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = encodePng(image, opaque);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFile(filePath, contents);
  return contents;
});

const writeIco = Effect.fn("writeErebusIconIco")(function* (
  filePath: string,
  renditions: ReadonlyMap<number, PNG>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const images = WINDOWS_ICON_SIZES.map((size) => {
    const rendition = renditions.get(size);
    if (!rendition) throw new Error(`Missing ${String(size)}px Erebus icon rendition.`);
    return { size, contents: encodePng(rendition) };
  });
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFile(filePath, encodePngIco(images));
});

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const darkGlyph = renderErebusIcon(OUTPUT_SIZE);
  const lightGlyph = renderIceWhiteErebusGlyph(OUTPUT_SIZE);
  const roundedTile = renderErebusIcon(OUTPUT_SIZE, "rounded");
  const squareTile = renderErebusIcon(OUTPUT_SIZE, "square");
  const appleTouchTile = renderErebusIcon(180, "square");
  const favicon16 = renderErebusIcon(16);
  const favicon32 = renderErebusIcon(32);
  const icoRenditions = new Map(
    WINDOWS_ICON_SIZES.map((size) => [size, renderErebusIcon(size)] as const),
  );

  assertTransparentCanvas(darkGlyph, "Erebus dark glyph");
  assertTransparentCanvas(lightGlyph, "Erebus light glyph");

  yield* writePng(path.join(root, "assets", "erebus-glyph-source.png"), darkGlyph);
  yield* writePng(path.join(root, "assets", "erebus-glyph-dark.png"), darkGlyph);
  yield* writePng(path.join(root, "assets", "erebus-glyph-light.png"), lightGlyph);
  yield* writePng(path.join(root, "assets", "erebus-desktop-1024.png"), darkGlyph);
  yield* writePng(path.join(root, "assets", "erebus-icon.png"), roundedTile);
  yield* writePng(path.join(root, "apps", "web", "public", "erebus-glyph-dark.png"), darkGlyph);
  yield* writePng(path.join(root, "apps", "web", "public", "erebus-glyph-light.png"), lightGlyph);

  const variants = [
    { directory: path.join(root, "assets", "dev"), prefix: "erebus-dev" },
    { directory: path.join(root, "assets", "nightly"), prefix: "erebus-nightly" },
    { directory: path.join(root, "assets", "prod"), prefix: "erebus" },
  ] as const;

  for (const variant of variants) {
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-universal-1024.png`),
      darkGlyph,
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-macos-1024.png`),
      squareTile,
      true,
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-ios-1024.png`),
      squareTile,
      true,
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-web-apple-touch-180.png`),
      appleTouchTile,
      true,
    );
    yield* writeIco(path.join(variant.directory, `${variant.prefix}-windows.ico`), icoRenditions);
    yield* writeIco(
      path.join(variant.directory, `${variant.prefix}-web-favicon.ico`),
      icoRenditions,
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-web-favicon-16x16.png`),
      favicon16,
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-web-favicon-32x32.png`),
      favicon32,
    );
  }

  yield* writeIco(path.join(root, "apps", "web", "public", "favicon.ico"), icoRenditions);
  yield* writePng(path.join(root, "apps", "web", "public", "favicon-16x16.png"), favicon16);
  yield* writePng(path.join(root, "apps", "web", "public", "favicon-32x32.png"), favicon32);
  yield* writePng(
    path.join(root, "apps", "web", "public", "apple-touch-icon.png"),
    appleTouchTile,
    true,
  );
});

Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer))).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
