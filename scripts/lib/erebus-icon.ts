import { PNG } from "pngjs";

type CanvasStyle = "transparent" | "rounded" | "square";

interface Point {
  readonly x: number;
  readonly y: number;
}

const MASTER_SIZE = 1024;
const DARK_GLYPH_COLOR = "#161313";
const LIGHT_GLYPH_COLOR = "#f4f1eb";
const TILE_COLOR = "#0b0a0a";
const TILE_BORDER_COLOR = "#292424";

// Responsive vector traced from the approved Erebus ouroboros artwork. The
// single open silhouette keeps the inner counter connected to the background,
// so it remains legible without a fill-rule exception at favicon sizes.
const ouroborosPoints = [
  { x: 869, y: 547 },
  { x: 859, y: 617 },
  { x: 834, y: 689 },
  { x: 795, y: 753 },
  { x: 747, y: 806 },
  { x: 694, y: 845 },
  { x: 630, y: 875 },
  { x: 567, y: 892 },
  { x: 498, y: 896 },
  { x: 422, y: 884 },
  { x: 355, y: 859 },
  { x: 292, y: 819 },
  { x: 246, y: 775 },
  { x: 200, y: 711 },
  { x: 171, y: 648 },
  { x: 156, y: 581 },
  { x: 154, y: 512 },
  { x: 160, y: 464 },
  { x: 173, y: 418 },
  { x: 193, y: 375 },
  { x: 212, y: 346 },
  { x: 198, y: 421 },
  { x: 197, y: 482 },
  { x: 204, y: 542 },
  { x: 218, y: 590 },
  { x: 232, y: 623 },
  { x: 258, y: 667 },
  { x: 290, y: 706 },
  { x: 323, y: 737 },
  { x: 361, y: 764 },
  { x: 396, y: 781 },
  { x: 436, y: 795 },
  { x: 475, y: 803 },
  { x: 523, y: 804 },
  { x: 568, y: 798 },
  { x: 612, y: 783 },
  { x: 551, y: 769 },
  { x: 624, y: 739 },
  { x: 655, y: 718 },
  { x: 679, y: 693 },
  { x: 699, y: 665 },
  { x: 715, y: 630 },
  { x: 731, y: 557 },
  { x: 728, y: 496 },
  { x: 710, y: 432 },
  { x: 682, y: 381 },
  { x: 642, y: 336 },
  { x: 600, y: 307 },
  { x: 554, y: 287 },
  { x: 510, y: 279 },
  { x: 447, y: 283 },
  { x: 405, y: 294 },
  { x: 372, y: 309 },
  { x: 410, y: 323 },
  { x: 375, y: 345 },
  { x: 364, y: 367 },
  { x: 336, y: 381 },
  { x: 298, y: 407 },
  { x: 274, y: 437 },
  { x: 263, y: 465 },
  { x: 238, y: 458 },
  { x: 211, y: 422 },
  { x: 228, y: 349 },
  { x: 227, y: 294 },
  { x: 258, y: 256 },
  { x: 273, y: 220 },
  { x: 294, y: 185 },
  { x: 338, y: 141 },
  { x: 371, y: 118 },
  { x: 318, y: 193 },
  { x: 305, y: 220 },
  { x: 303, y: 241 },
  { x: 345, y: 198 },
  { x: 391, y: 162 },
  { x: 442, y: 134 },
  { x: 493, y: 116 },
  { x: 441, y: 152 },
  { x: 407, y: 181 },
  { x: 381, y: 211 },
  { x: 368, y: 240 },
  { x: 405, y: 202 },
  { x: 433, y: 190 },
  { x: 496, y: 176 },
  { x: 554, y: 177 },
  { x: 600, y: 189 },
  { x: 640, y: 208 },
  { x: 688, y: 246 },
  { x: 729, y: 287 },
  { x: 692, y: 238 },
  { x: 645, y: 198 },
  { x: 666, y: 180 },
  { x: 681, y: 158 },
  { x: 728, y: 180 },
  { x: 766, y: 209 },
  { x: 799, y: 241 },
  { x: 828, y: 276 },
  { x: 850, y: 311 },
  { x: 770, y: 265 },
  { x: 740, y: 255 },
  { x: 737, y: 261 },
  { x: 774, y: 295 },
  { x: 798, y: 323 },
  { x: 839, y: 392 },
  { x: 855, y: 435 },
  { x: 864, y: 473 },
] as const satisfies ReadonlyArray<Point>;

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

function renderOuroboros(size: number, canvas: CanvasStyle, color: string): PNG {
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

  const glyphScale = canvas === "transparent" ? 1 : 0.94;
  fillPolygon(
    raster,
    ouroborosPoints.map((point) => ({
      x: (512 + (point.x - 512) * glyphScale) * rasterScale,
      y: (512 + (point.y - 512) * glyphScale) * rasterScale,
    })),
    color,
  );

  return resizeErebusIcon(raster, size);
}

export function renderErebusIcon(size: number, canvas: CanvasStyle = "transparent"): PNG {
  return renderOuroboros(
    size,
    canvas,
    canvas === "transparent" ? DARK_GLYPH_COLOR : LIGHT_GLYPH_COLOR,
  );
}

export function renderIceWhiteErebusGlyph(size: number): PNG {
  return renderOuroboros(size, "transparent", LIGHT_GLYPH_COLOR);
}
