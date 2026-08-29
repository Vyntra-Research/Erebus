import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PNG } from "pngjs";

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

function keepLargestAlphaComponent(source: PNG): PNG {
  const visited = new Uint8Array(source.width * source.height);
  let largest: number[] = [];
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || source.data[start * 4 + 3]! <= 16) continue;
    const component: number[] = [];
    const queue = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const pixel = queue[cursor]!;
      component.push(pixel);
      const x = pixel % source.width;
      const y = Math.floor(pixel / source.width);
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < source.width ? pixel + 1 : -1,
        y > 0 ? pixel - source.width : -1,
        y + 1 < source.height ? pixel + source.width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || source.data[neighbor * 4 + 3]! <= 16) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    if (component.length > largest.length) largest = component;
  }

  const retained = new Uint8Array(visited.length);
  for (const pixel of largest) retained[pixel] = 1;
  const output = new PNG({ width: source.width, height: source.height });
  source.data.copy(output.data);
  for (let pixel = 0; pixel < retained.length; pixel++) {
    if (!retained[pixel]) output.data[pixel * 4 + 3] = 0;
  }
  return output;
}

function resize(source: PNG, width: number, height = width): PNG {
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sourceY = ((y + 0.5) * source.height) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const wy = Math.max(0, sourceY - y0);
    for (let x = 0; x < width; x++) {
      const sourceX = ((x + 0.5) * source.width) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const wx = Math.max(0, sourceX - x0);
      const samples = [
        [x0, y0, (1 - wx) * (1 - wy)],
        [x1, y0, wx * (1 - wy)],
        [x0, y1, (1 - wx) * wy],
        [x1, y1, wx * wy],
      ] as const;
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const [sampleX, sampleY, weight] of samples) {
        const offset = (sampleY * source.width + sampleX) * 4;
        const sampleAlpha = source.data[offset + 3]! / 255;
        alpha += sampleAlpha * weight;
        red += source.data[offset]! * sampleAlpha * weight;
        green += source.data[offset + 1]! * sampleAlpha * weight;
        blue += source.data[offset + 2]! * sampleAlpha * weight;
      }
      const outputOffset = (y * width + x) * 4;
      if (alpha > 0) {
        output.data[outputOffset] = Math.round(red / alpha);
        output.data[outputOffset + 1] = Math.round(green / alpha);
        output.data[outputOffset + 2] = Math.round(blue / alpha);
      }
      output.data[outputOffset + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}

function iceWhite(source: PNG): PNG {
  const output = new PNG({ width: source.width, height: source.height });
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const luminance =
      source.data[offset]! * 0.2126 +
      source.data[offset + 1]! * 0.7152 +
      source.data[offset + 2]! * 0.0722;
    const value = Math.round(218 + (luminance / 255) * 34);
    output.data[offset] = Math.min(255, value);
    output.data[offset + 1] = Math.min(255, value + 3);
    output.data[offset + 2] = Math.min(255, value + 7);
    output.data[offset + 3] = source.data[offset + 3]!;
  }
  return output;
}

function maxFilter(values: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(values.length);
  const output = new Uint8Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maximum = 0;
      for (
        let sampleX = Math.max(0, x - radius);
        sampleX <= Math.min(width - 1, x + radius);
        sampleX++
      ) {
        maximum = Math.max(maximum, values[y * width + sampleX]!);
      }
      horizontal[y * width + x] = maximum;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maximum = 0;
      for (
        let sampleY = Math.max(0, y - radius);
        sampleY <= Math.min(height - 1, y + radius);
        sampleY++
      ) {
        maximum = Math.max(maximum, horizontal[sampleY * width + x]!);
      }
      output[y * width + x] = maximum;
    }
  }
  return output;
}

function addIceContour(source: PNG): PNG {
  const alpha = new Uint8Array(source.width * source.height);
  for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = source.data[pixel * 4 + 3]!;
  const dilated = maxFilter(alpha, source.width, source.height, 7);
  const output = new PNG({ width: source.width, height: source.height });

  for (let pixel = 0; pixel < alpha.length; pixel++) {
    const sourceOffset = pixel * 4;
    const sourceAlpha = alpha[pixel]! / 255;
    const contourAlpha = Math.max(0, dilated[pixel]! / 255 - sourceAlpha) * 0.72;
    const outputAlpha = sourceAlpha + contourAlpha * (1 - sourceAlpha);
    if (outputAlpha > 0) {
      output.data[sourceOffset] = Math.round(
        (source.data[sourceOffset]! * sourceAlpha + 224 * contourAlpha * (1 - sourceAlpha)) /
          outputAlpha,
      );
      output.data[sourceOffset + 1] = Math.round(
        (source.data[sourceOffset + 1]! * sourceAlpha + 230 * contourAlpha * (1 - sourceAlpha)) /
          outputAlpha,
      );
      output.data[sourceOffset + 2] = Math.round(
        (source.data[sourceOffset + 2]! * sourceAlpha + 238 * contourAlpha * (1 - sourceAlpha)) /
          outputAlpha,
      );
    }
    output.data[sourceOffset + 3] = Math.round(outputAlpha * 255);
  }
  return output;
}

function encodePng(image: PNG): Buffer {
  return PNG.sync.write(image, { colorType: 6 });
}

const writePng = Effect.fn("writeErebusIconPng")(function* (filePath: string, image: PNG) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = PNG.sync.write(image, { colorType: 6 });
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFile(filePath, contents);
  return contents;
});

const writeIco = Effect.fn("writeErebusIconIco")(function* (filePath: string, image: PNG) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const renditions = WINDOWS_ICON_SIZES.map((size) => ({
    size,
    contents: encodePng(resize(image, size)),
  }));
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFile(filePath, encodePngIco(renditions));
});

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const sourcePath = path.join(root, "assets", "erebus-glyph-source.png");
  const source = keepLargestAlphaComponent(
    PNG.sync.read(Buffer.from(yield* fileSystem.readFile(sourcePath))),
  );
  const darkGlyph = resize(source, OUTPUT_SIZE);
  const lightGlyph = iceWhite(darkGlyph);
  const desktopGlyph = addIceContour(darkGlyph);

  assertTransparentCanvas(source, "Erebus glyph source");
  assertTransparentCanvas(darkGlyph, "Erebus dark glyph");
  assertTransparentCanvas(lightGlyph, "Erebus light glyph");
  assertTransparentCanvas(desktopGlyph, "Erebus desktop glyph");

  yield* writePng(path.join(root, "assets", "erebus-glyph-dark.png"), darkGlyph);
  yield* writePng(path.join(root, "assets", "erebus-glyph-light.png"), lightGlyph);
  yield* writePng(path.join(root, "assets", "erebus-desktop-1024.png"), desktopGlyph);
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
      desktopGlyph,
    );
    yield* writeIco(path.join(variant.directory, `${variant.prefix}-windows.ico`), desktopGlyph);
    yield* writeIco(
      path.join(variant.directory, `${variant.prefix}-web-favicon.ico`),
      desktopGlyph,
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-web-favicon-16x16.png`),
      resize(desktopGlyph, 16),
    );
    yield* writePng(
      path.join(variant.directory, `${variant.prefix}-web-favicon-32x32.png`),
      resize(desktopGlyph, 32),
    );
  }
});

Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer))).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
