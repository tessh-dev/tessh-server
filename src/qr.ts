// A small QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-40.
// It picks the smallest version that fits and the mask with the lowest penalty score, and draws the
// symbol as an SVG with one path, so the page needs no inline styles or scripts.

/** Error correction level M per version: [EC codewords per block, group 1 blocks, data codewords, group 2 blocks, data codewords]. */
const BLOCKS_M: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0], [28, 17, 46, 0, 0], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46], [28, 8, 47, 13, 48],
  [28, 19, 46, 4, 47], [28, 22, 45, 3, 46], [28, 3, 45, 23, 46], [28, 21, 45, 7, 46], [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47], [28, 10, 46, 23, 47], [28, 14, 46, 21, 47], [28, 14, 46, 23, 47], [28, 12, 47, 26, 48],
  [28, 6, 47, 34, 48], [28, 29, 46, 14, 47], [28, 13, 46, 32, 47], [28, 40, 47, 7, 48], [28, 18, 47, 31, 48],
];

export const MAX_VERSION = 40;
/** The two bits level M puts in the format information. */
const ECL_M_BITS = 0b00;

const dataCodewords = (v: number): number => {
  const [, b1, d1, b2, d2] = BLOCKS_M[v - 1];
  return b1 * d1 + b2 * d2;
};
const countBits = (v: number): number => (v < 10 ? 8 : 16);

/** How many bytes fit at version `v`, level M, in byte mode. */
export const byteCapacity = (v: number): number => Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8);

/** The smallest version (1-40) that holds `length` bytes, or null when nothing does. */
export function pickVersion(length: number): number | null {
  for (let v = 1; v <= MAX_VERSION; v++) if (byteCapacity(v) >= length) return v;
  return null;
}

/** Centres of the alignment patterns along one axis. */
export function alignmentPositions(v: number): number[] {
  if (v === 1) return [];
  const count = Math.floor(v / 7) + 2;
  const size = v * 4 + 17;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---- BCH codes for the format and version information ----

const bchRemainder = (value: number, poly: number, polyDegree: number, dataBits: number): number => {
  let r = value << polyDegree;
  for (let bit = dataBits + polyDegree - 1; bit >= polyDegree; bit--) if ((r >>> bit) & 1) r ^= poly << (bit - polyDegree);
  return r;
};

/** The 15 format bits for level M and `mask`, already XORed with 101010000010010. */
export function formatBits(mask: number): number {
  const data = (ECL_M_BITS << 3) | mask;
  return ((data << 10) | bchRemainder(data, 0b10100110111, 10, 5)) ^ 0b101010000010010;
}

/** The 18 version bits (versions 7 and up). */
export function versionBits(v: number): number {
  return (v << 12) | bchRemainder(v, 0b1111100100101, 12, 6);
}

// ---- Reed-Solomon over GF(256), polynomial 0x11d ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of degree `n`, highest term first without its leading 1. */
function generator(n: number): Uint8Array {
  let g = Uint8Array.of(1);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g.subarray(1);
}

/** The `n` error correction codewords for `data`. */
export function reedSolomon(data: Uint8Array, n: number): Uint8Array {
  const gen = generator(n);
  const rem = new Uint8Array(n);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[n - 1] = 0;
    for (let i = 0; i < n; i++) rem[i] ^= mul(gen[i], factor);
  }
  return rem;
}

// ---- Codewords ----

function codewords(bytes: Uint8Array, v: number): Uint8Array {
  const capacity = dataCodewords(v);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(v));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) data[i / 8] = bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0);
  for (let i = bits.length / 8, pad = 0; i < capacity; i++, pad ^= 1) data[i] = pad ? 0x11 : 0xec;

  const [ec, b1, d1, b2, d2] = BLOCKS_M[v - 1];
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let at = 0;
  for (const [count, size] of [[b1, d1], [b2, d2]]) {
    for (let i = 0; i < count; i++) {
      const block = data.subarray(at, at + size);
      at += size;
      blocks.push(block);
      ecBlocks.push(reedSolomon(block, ec));
    }
  }
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return Uint8Array.from(out);
}

// ---- The symbol ----

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export interface QRCode {
  version: number;
  mask: number;
  size: number;
  /** `modules[row][col]`, true for dark. */
  modules: boolean[][];
}

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  readonly version: number;
  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(r: number, c: number, dark: boolean) {
    this.dark[r][c] = dark;
    this.fixed[r][c] = true;
  }
}

function drawFunctionPatterns(g: Grid): void {
  const n = g.size;
  for (const [r0, c0] of [[3, 3], [3, n - 4], [n - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const d = Math.max(Math.abs(dr), Math.abs(dc));
        g.set(r, c, d !== 2 && d !== 4);
      }
    }
  }
  for (let i = 8; i < n - 8; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  const pos = alignmentPositions(g.version);
  const last = pos.length - 1;
  pos.forEach((r, i) => {
    pos.forEach((c, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // finder corners
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) g.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    });
  });
  drawFormat(g, 0); // reserves the cells; the real bits come with the mask
  if (g.version >= 7) {
    const bits = versionBits(g.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3), b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

function drawFormat(g: Grid, mask: number): void {
  const n = g.size;
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) g.set(i, 8, bit(i));
  g.set(7, 8, bit(6));
  g.set(8, 8, bit(7));
  g.set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) g.set(8, 14 - i, bit(i));
  // Split between the other two finders.
  for (let i = 0; i < 8; i++) g.set(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) g.set(n - 15 + i, 8, bit(i));
  g.set(n - 8, 8, true); // the dark module
}

function placeData(g: Grid, data: Uint8Array): void {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let k = 0; k < n; k++) {
      const r = upward ? n - 1 - k : k;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (g.fixed[r][c]) continue;
        if (i < data.length * 8) g.dark[r][c] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++; // remainder bits stay light
      }
    }
  }
}

function applyMask(g: Grid, mask: number): boolean[][] {
  const fn = MASKS[mask];
  return g.dark.map((row, r) => row.map((d, c) => (g.fixed[r][c] ? d : d !== fn(r, c))));
}

/** The penalty score from ISO/IEC 18004 section 7.8.3; the lowest wins. */
export function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      for (let b = 0; b + 11 <= n; b++) {
        const w = (k: number) => get(a, b + k);
        const core = w(4) && !w(5) && w(6) && w(7) && w(8) && !w(9) && w(10);
        const coreFirst = w(0) && !w(1) && w(2) && w(3) && w(4) && !w(5) && w(6);
        if (core && !w(0) && !w(1) && !w(2) && !w(3)) score += 40;
        if (coreFirst && !w(7) && !w(8) && !w(9) && !w(10)) score += 40;
      }
    }
  };
  lines((r, c) => m[r][c]);
  lines((c, r) => m[r][c]);
  for (let r = 0; r + 1 < n; r++) {
    for (let c = 0; c + 1 < n; c++) {
      const d = m[r][c];
      if (m[r][c + 1] === d && m[r + 1][c] === d && m[r + 1][c + 1] === d) score += 3;
    }
  }
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Encodes `input` (UTF-8 for a string). `mask` forces a mask pattern, otherwise the best is picked. */
export function encodeQR(input: string | Uint8Array, opts: { mask?: number } = {}): QRCode {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const version = pickVersion(bytes.length);
  if (version === null) throw new RangeError("Too much data for a QR code");
  const g = new Grid(version);
  drawFunctionPatterns(g);
  placeData(g, codewords(bytes, version));
  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (const mask of opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask]) {
    drawFormat(g, mask);
    const modules = applyMask(g, mask);
    const score = opts.mask === undefined ? penalty(modules) : 0;
    if (!best || score < best.score) best = { mask, modules, score };
  }
  return { version, mask: best!.mask, size: g.size, modules: best!.modules };
}

/**
 * The code as an SVG: dark modules in one path over a white square, with a `margin`-module quiet zone.
 * Sized by CSS; no inline styles, so it suits a `style-src 'self'` page.
 */
export function qrSVG(input: string | Uint8Array, margin = 2): string {
  const { size, modules } = encodeQR(input);
  const full = size + margin * 2;
  let d = "";
  modules.forEach((row, r) => {
    for (let c = 0; c < size; c++) {
      if (!row[c]) continue;
      let w = 1;
      while (c + w < size && row[c + w]) w++;
      d += `M${c + margin} ${r + margin}h${w}v1h-${w}z`;
      c += w - 1;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="QR code"><path fill="#fff" d="M0 0h${full}v${full}H0z"/><path fill="#000" d="${d}"/></svg>`;
}
