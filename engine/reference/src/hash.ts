const MASK_U24 = 0xffffff;
const PRIME_U24 = 0x27d4eb;
const BIAS_U24 = 374761;
const SALT_A = 0x9e3779;
const SALT_B = 0x85ebca;
const SALT_C = 0xc2b2ae;
const FNV_BASIS_U24 = 0x811c9d;

function mixU24(hash: number, value: number): number {
  const x = (hash ^ (value & MASK_U24)) & MASK_U24;
  return ((x * PRIME_U24 + BIAS_U24) & MASK_U24) >>> 0;
}

export function hashU24(seed: number, a: number, b: number, c: number): number {
  let h = seed & MASK_U24;
  h = mixU24(h, (a + SALT_A) & MASK_U24);
  h = mixU24(h, (b + SALT_B) & MASK_U24);
  h = mixU24(h, (c + SALT_C) & MASK_U24);
  return h >>> 0;
}

export function hashFloat01(seed: number, a: number, b: number, c: number): number {
  return hashU24(seed, a, b, c) / (MASK_U24 + 1);
}

export function hashChoice(seed: number, a: number, b: number, c: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return hashU24(seed, a, b, c) % length;
}

export function hashU24Mod(seed: number, a: number, b: number, c: number, mod: number): number {
  if (mod <= 0) {
    return 0;
  }
  return hashU24(seed, a, b, c) % mod;
}

export function digestStateHex(types: Uint8Array, energy10: Uint16Array, age: Uint16Array): string {
  let hash = FNV_BASIS_U24;

  for (const value of types) {
    hash = mixU24(hash, value);
  }

  for (const value of energy10) {
    hash = mixU24(hash, value);
  }

  for (const value of age) {
    hash = mixU24(hash, value);
  }

  return hash.toString(16).padStart(6, "0");
}
