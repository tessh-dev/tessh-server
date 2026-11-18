import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { alignmentPositions, byteCapacity, encodeQR, formatBits, penalty, pickVersion, qrSVG, reedSolomon, versionBits } from "../src/qr.ts";

const rows = (m: boolean[][]) => m.map((r) => r.map((x) => (x ? "1" : "0")).join(""));
const hash = (m: boolean[][]) => createHash("sha256").update(rows(m).join("\n")).digest("hex");

// Reference symbols made once with an independent encoder (python-qrcode 8, byte mode, level M, each mask forced).
// Each entry is the SHA-256 of the module rows ("0"/"1", joined by "\n") for masks 0-7.
const URI = "otpauth://totp/Tessh%20Server:owner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Tessh%20Server";
const REFERENCE: { name: string; input: string; version: number; masks: string[] }[] = [
  {
    name: "version 1, one block",
    input: "hello",
    version: 1,
    masks: [
      "52a7aa67e7296ede539d6be86579c7180e3b6d417445712ae8bd314c1818458a",
      "b5607dcfbd80e2bc0b80d411972d3040856f159f49f2932fe5e9f24181ee1225",
      "f67f2bc632df800dbc2c111f69cd9af3812f0488abf74fb397641a9c00b86c64",
      "75b99c66edebbd9092e05881d5108e41c788e2e7f48bea1cc443b640895efa98",
      "c81027800a8044d0762e47033b67cf0ead403170b24e9e4ff25203a9f92c7020",
      "aab8a0a72b21c8c63c7d29fb79889a5cf663a94745c683d332f8ca36b6c93d79",
      "073eb88268c25799dc8d72588f97027756b7fedd3a9a09bcc7e81a54fb29d3ef",
      "683921f56b2988dd454e5f08cc85d949682bd846d510fe13aa028a95d1427918",
    ],
  },
  {
    name: "version 7, an otpauth link: version info, four blocks, alignment on the timing lines",
    input: URI,
    version: 7,
    masks: [
      "bfbc654845d67642841e84787b88dec0c0db9f4715e077f222ad8b6e8de72c17",
      "53063466537099bd467699cbaad97a74580abd313f0a48e2ef26f730067326cb",
      "490475f2ee735e0b317c14153ba2b41dea171df182c6ae5be11b0d755957f3e6",
      "3e679464107be76917ffd59aafe30d16556ea83ed4ff64846219c5eac9fb1621",
      "98bf907bc8976bbf6bacf53168acdf03316168e52f86597d717811e4336eeec9",
      "e68dcfaa0dfdbe24ad02afbb13e6521153557fcc0a84f3c44bfe59b9f5056740",
      "18d2a5a9276af0d87f26090db9854c0f6b5a5d37176096b655500ff175d696b6",
      "7002fa5e95869af265ae184f91b527db78cbdfc91d90c4e2709334a8038cfc5d",
    ],
  },
  {
    name: "version 10: 16-bit length, two block sizes",
    input: "x".repeat(200),
    version: 10,
    masks: [
      "1e21180d1f36a922d626c44d8ee71b15e778ed0b3f02150d91b337171f504845",
      "f1d915a92d671e6907ea313afbaac0ab35a6c92dfec1f50f3eae1c35ba97c316",
      "64e9db0f7dcfa486be63739a1efef2c8324387cf233f7686c75d9b4e079a8873",
      "9787723b9e5d5a0d4645883638cf7a50dc463b31ad95a18c29f5ab10d728a860",
      "cc2d9cd4f08150dff2975c39f5f3e5dc16cec8918aa4374e3b9c7ead55b86169",
      "4d9d35a0f7deae1bd699a42c52c7350938e780be208e22bef9247b2f87dd1a0c",
      "3db312672d9837828c20947cb7d0be7e769f5ef7bfebdea5b0d6897f2f45d3f9",
      "817b94e1364e8b1bd61885c4afffe6d4d322a3782e1f6f1019c13cf15e64032a",
    ],
  },
];

// The same reference, "hello" with mask 0, in full.
const HELLO_MASK0 = [
  "111111100110001111111",
  "100000101100001000001",
  "101110100101101011101",
  "101110100011001011101",
  "101110101100101011101",
  "100000100000101000001",
  "111111101010101111111",
  "000000000011100000000",
  "101010100101000010010",
  "001011000010001000011",
  "010100101110100011111",
  "110010000000001000010",
  "011010110010101010000",
  "000000001111010100111",
  "111111100011011100111",
  "100000100011110110000",
  "101110101011011100011",
  "101110100100001100110",
  "101110101110100010101",
  "100000100100001010010",
  "111111101110101100011",
];

describe("QR encoder", () => {
  it("matches the reference module for module", () => {
    expect(rows(encodeQR("hello", { mask: 0 }).modules)).toEqual(HELLO_MASK0);
    for (const ref of REFERENCE) {
      for (let mask = 0; mask < 8; mask++) {
        const q = encodeQR(ref.input, { mask });
        expect(q.version, ref.name).toBe(ref.version);
        expect(q.size).toBe(ref.version * 4 + 17);
        expect(hash(q.modules), `${ref.name}, mask ${mask}`).toBe(ref.masks[mask]);
      }
    }
  });

  it("picks the mask with the lowest penalty, the first on a tie", () => {
    for (const input of ["hello", URI, "x".repeat(200)]) {
      const scores = Array.from({ length: 8 }, (_, mask) => penalty(encodeQR(input, { mask }).modules));
      const q = encodeQR(input);
      expect(q.mask).toBe(scores.indexOf(Math.min(...scores)));
      expect(q.modules).toEqual(encodeQR(input, { mask: q.mask }).modules);
    }
  });

  it("scores the four penalty rules", () => {
    const grid = (s: string[]) => s.map((r) => [...r].map((x) => x === "1"));
    // Rule 4 only: a checkerboard is exactly half dark, with no runs, blocks or finder shapes.
    const checker = Array.from({ length: 12 }, (_, r) => Array.from({ length: 12 }, (_, c) => ((r + c) % 2 ? "1" : "0")).join(""));
    expect(penalty(grid(checker))).toBe(0);
    // All light, 12x12: runs of 12 in 24 lines (10 each), 121 2x2 blocks (3 each), 0% dark (100).
    expect(penalty(grid(Array(12).fill("0".repeat(12))))).toBe(24 * 10 + 121 * 3 + 100);
  });

  it("encodes UTF-8 bytes", () => {
    expect(encodeQR("é").modules).toEqual(encodeQR(Uint8Array.of(0xc3, 0xa9)).modules);
  });
});

describe("QR format and version information", () => {
  it("matches the standard's format words for level M", () => {
    const table = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
    expect(Array.from({ length: 8 }, (_, m) => formatBits(m))).toEqual(table);
  });

  it("keeps format words at least 7 bits apart, as a BCH(15,5) code should", () => {
    const words = Array.from({ length: 8 }, (_, m) => formatBits(m));
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        let x = words[i] ^ words[j];
        let d = 0;
        while (x) {
          d += x & 1;
          x >>>= 1;
        }
        expect(d).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("matches the standard's version words", () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(10)).toBe(0x0a4d3);
    expect(versionBits(40)).toBe(0x28c69);
  });

  it("places alignment patterns where the standard does", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(10)).toEqual([6, 28, 50]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(36)).toEqual([6, 24, 50, 76, 102, 128, 154]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  it("computes Reed-Solomon codewords like the standard's worked example", () => {
    // ISO/IEC 18004 Annex I: "01234567" in version 1-M.
    const data = Uint8Array.of(0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11);
    expect([...reedSolomon(data, 10)]).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });
});

describe("QR version selection", () => {
  it("knows the level M byte capacities", () => {
    expect(Array.from({ length: 10 }, (_, i) => byteCapacity(i + 1))).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
    expect(byteCapacity(40)).toBe(2331);
  });

  it("picks the smallest version that fits", () => {
    expect(pickVersion(1)).toBe(1);
    expect(pickVersion(14)).toBe(1);
    expect(pickVersion(15)).toBe(2);
    expect(pickVersion(122)).toBe(7);
    expect(pickVersion(123)).toBe(8);
    expect(pickVersion(213)).toBe(10);
    expect(pickVersion(214)).toBe(11);
    expect(pickVersion(2331)).toBe(40);
    expect(pickVersion(2332)).toBeNull();
    expect(() => encodeQR("x".repeat(2332))).toThrow(RangeError);
    expect(encodeQR(URI).version).toBe(7);
  });
});

describe("QR SVG", () => {
  it("draws every dark module, crisp, with no inline styles or scripts", () => {
    const svg = qrSVG(URI);
    const q = encodeQR(URI);
    const full = q.size + 4;
    expect(svg).toMatch(new RegExp(`^<svg [^>]*viewBox="0 0 ${full} ${full}"`));
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).not.toMatch(/style=|<script|<style|on\w+=/i);
    const paths = [...svg.matchAll(/<path fill="([^"]+)" d="([^"]+)"\/>/g)];
    expect(paths.map((p) => p[1])).toEqual(["#fff", "#000"]);
    // Rebuild the matrix from the dark path's runs.
    const back = Array.from({ length: q.size }, () => new Array<boolean>(q.size).fill(false));
    for (const [, x, y, w] of paths[1][2].matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let i = 0; i < Number(w); i++) back[Number(y) - 2][Number(x) - 2 + i] = true;
    }
    expect(back).toEqual(q.modules);
  });
});
