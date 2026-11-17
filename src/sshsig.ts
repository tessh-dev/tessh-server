// Verifies OpenSSH PROTOCOL.sshsig signatures (Ed25519 over SHA-512), the format TesshCore's SSHSig.sign writes.
import { decodeBase64 } from "./auth.ts";

const enc = new TextEncoder();
const MAGIC = enc.encode("SSHSIG");
const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";
const MAX_ARMOR = 4096;

class Reader {
  private off = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  bytes(n: number): Uint8Array {
    if (this.off + n > this.buf.length) throw new Error("short");
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  u32(): number {
    const b = this.bytes(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  string(): Uint8Array {
    return this.bytes(this.u32());
  }
  text(): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.string());
  }
  done(): boolean {
    return this.off === this.buf.length;
  }
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function sshString(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The SSH wire blob of an `ssh-ed25519 <b64>` line, or null if the line is not one. */
export function ed25519Blob(line: string): Uint8Array | null {
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(line);
  const blob = m && decodeBase64(m[1]);
  if (!blob) return null;
  try {
    const r = new Reader(blob);
    if (r.text() !== "ssh-ed25519" || r.string().length !== 32 || !r.done()) return null;
  } catch {
    return null;
  }
  return blob;
}

/**
 * True when `armored` is a valid SSHSIG over exactly `message`, made by `signer` (an `ssh-ed25519 <b64>`
 * line) for `namespace` with sha512. Any parse error or mismatch returns false.
 */
export async function verifySSHSig(message: Uint8Array, armored: string, signer: string, namespace: string): Promise<boolean> {
  try {
    if (armored.length > MAX_ARMOR) return false;
    const lines = armored.replace(/\r?\n$/, "").split(/\r?\n/);
    if (lines.length < 3 || lines[0] !== BEGIN || lines[lines.length - 1] !== END) return false;
    const raw = decodeBase64(lines.slice(1, -1).join(""));
    const signerBlob = ed25519Blob(signer);
    if (!raw || !signerBlob) return false;

    const r = new Reader(raw);
    if (!eq(r.bytes(6), MAGIC) || r.u32() !== 1) return false;
    const publicKey = r.string();
    const ns = r.string();
    const reserved = r.string();
    const hashAlg = r.string();
    const sigBlob = r.string();
    if (!r.done()) return false;
    if (!eq(publicKey, signerBlob)) return false;
    if (!eq(ns, enc.encode(namespace)) || !eq(hashAlg, enc.encode("sha512"))) return false;

    const s = new Reader(sigBlob);
    if (s.text() !== "ssh-ed25519") return false;
    const sig = s.string();
    if (sig.length !== 64 || !s.done()) return false;

    const pk = new Reader(signerBlob);
    pk.string();
    const rawKey = pk.string();

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", message));
    const signed = concat(MAGIC, sshString(ns), sshString(reserved), sshString(hashAlg), sshString(digest));
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, signed);
  } catch {
    return false;
  }
}
