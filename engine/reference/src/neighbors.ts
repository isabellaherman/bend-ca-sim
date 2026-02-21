import type { SimConfig } from "@ca-sim/contracts";

const OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
];

function wrap(value: number, size: number): number {
  if (value < 0) {
    return value + size;
  }
  if (value >= size) {
    return value - size;
  }
  return value;
}

export function precomputeNeighbors(config: SimConfig): Uint32Array {
  const { width, height, wrapWorld } = config;
  const size = width * height;
  const neighbors = new Uint32Array(size * 8);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const base = idx * 8;
      for (let k = 0; k < 8; k += 1) {
        const [ox, oy] = OFFSETS[k] ?? [0, 0];
        let nx = x + ox;
        let ny = y + oy;
        if (wrapWorld) {
          nx = wrap(nx, width);
          ny = wrap(ny, height);
          neighbors[base + k] = ny * width + nx;
          continue;
        }
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          neighbors[base + k] = idx;
          continue;
        }
        neighbors[base + k] = ny * width + nx;
      }
    }
  }
  return neighbors;
}
