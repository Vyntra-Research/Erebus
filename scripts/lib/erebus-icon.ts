import { PNG } from "pngjs";

type CanvasStyle = "transparent" | "rounded" | "square";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Face {
  readonly color: string;
  readonly points: ReadonlyArray<Point>;
}

const MASTER_SIZE = 1024;
const TILE_COLOR = "#f3eee6";
const TILE_BORDER_COLOR = "#ded5c9";

const points = {
  a: { x: 414, y: 56 },
  b: { x: 673, y: 121 },
  c: { x: 848, y: 351 },
  d: { x: 889, y: 741 },
  e: { x: 849, y: 872 },
  f: { x: 660, y: 926 },
  g: { x: 143, y: 888 },
  h: { x: 82, y: 714 },
  i: { x: 219, y: 270 },
  p: { x: 496, y: 319 },
  q: { x: 779, y: 423 },
  r: { x: 674, y: 877 },
  s: { x: 333, y: 630 },
} as const satisfies Record<string, Point>;

const faces = [
  { color: "#573034", points: [points.i, points.a, points.p] },
  { color: "#1c0e0e", points: [points.a, points.b, points.c, points.q, points.p] },
  { color: "#3d2022", points: [points.i, points.p, points.s, points.h] },
  { color: "#29191b", points: [points.p, points.q, points.r, points.s] },
  { color: "#070304", points: [points.c, points.d, points.e, points.r, points.q] },
  {
    color: "#120709",
    points: [points.h, points.s, points.r, points.e, points.f, points.g],
  },
] as const satisfies ReadonlyArray<Face>;

function parseHexColor(color: string): readonly [number, number, number, number] {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new Error(`Invalid Erebus icon color: ${color}`);
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    255,
  ];
}

function writePixel(
  image: PNG,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
  image.data[offset + 3] = color[3];
}

function fillCanvas(image: PNG, color: string): void {
  const rgba = parseHexColor(color);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      writePixel(image, x, y, rgba);
    }
  }
}

function fillRoundedTile(image: PNG, scale: number): void {
  const fill = parseHexColor(TILE_COLOR);
  const border = parseHexColor(TILE_BORDER_COLOR);
  const margin = 24 * scale;
  const radius = 216 * scale;
  const borderWidth = 8 * scale;
  const right = image.width - margin;
  const bottom = image.height - margin;

  const distanceFromRoundedRect = (x: number, y: number): number => {
    const nearestX = Math.max(margin + radius, Math.min(x, right - radius));
    const nearestY = Math.max(margin + radius, Math.min(y, bottom - radius));
    return Math.hypot(x - nearestX, y - nearestY) - radius;
  };

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const distance = distanceFromRoundedRect(x + 0.5, y + 0.5);
      if (distance <= 0) {
        writePixel(image, x, y, distance >= -borderWidth ? border : fill);
      }
    }
  }
}

function fillPolygon(image: PNG, polygon: ReadonlyArray<Point>, color: string): void {
  const rgba = parseHexColor(color);
  const minimumY = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.y))));
  const maximumY = Math.min(
    image.height - 1,
    Math.ceil(Math.max(...polygon.map((point) => point.y))),
  );

  for (let y = minimumY; y <= maximumY; y++) {
    const sampleY = y + 0.5;
    const intersections: number[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const current = polygon[index]!;
      const next = polygon[(index + 1) % polygon.length]!;
      const crossesScanline =
        (current.y <= sampleY && next.y > sampleY) || (next.y <= sampleY && current.y > sampleY);
      if (!crossesScanline) continue;
      const progress = (sampleY - current.y) / (next.y - current.y);
      intersections.push(current.x + progress * (next.x - current.x));
    }
    intersections.sort((left, right) => left - right);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const start = Math.max(0, Math.ceil(intersections[index]! - 0.5));
      const end = Math.min(image.width - 1, Math.floor(intersections[index + 1]! - 0.5));
      for (let x = start; x <= end; x++) {
        writePixel(image, x, y, rgba);
      }
    }
  }
}

export function resizeErebusIcon(source: PNG, width: number, height = width): PNG {
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

export function renderErebusIcon(size: number, canvas: CanvasStyle = "transparent"): PNG {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Erebus icon size must be a positive integer, got ${String(size)}.`);
  }
  const supersample = size <= 256 ? 8 : 4;
  const rasterSize = size * supersample;
  const raster = new PNG({ width: rasterSize, height: rasterSize });
  const rasterScale = rasterSize / MASTER_SIZE;

  if (canvas === "square") {
    fillCanvas(raster, TILE_COLOR);
  } else if (canvas === "rounded") {
    fillRoundedTile(raster, rasterScale);
  }

  const glyphScale = canvas === "transparent" ? 1 : 0.72;
  const verticalOffset = canvas === "transparent" ? 0 : 12;
  for (const face of faces) {
    fillPolygon(
      raster,
      face.points.map((point) => ({
        x: (512 + (point.x - 512) * glyphScale) * rasterScale,
        y: (512 + (point.y - 512) * glyphScale + verticalOffset) * rasterScale,
      })),
      face.color,
    );
  }

  return resizeErebusIcon(raster, size);
}

export function renderIceWhiteErebusGlyph(size: number): PNG {
  const source = renderErebusIcon(size);
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
