import { SELF } from "./harness.ts";

export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
export const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

export function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return SELF.fetch(`https://api.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const KDF = { alg: "argon2id", opslimit: 3, memlimit: 67108864 };

export function registerBody(email: string, over: Record<string, unknown> = {}) {
  return {
    email,
    authKey: b64(bytes(32, 1)),
    salt: b64(bytes(16, 2)),
    kdf: KDF,
    wrappedVaultKey: b64(bytes(60, 3)),
    encryptedSigningKey: b64(bytes(60, 4)),
    signerPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGFrZQ",
    recoveryAuthKey: b64(bytes(32, 11)),
    wrappedVaultKeyRecovery: b64(bytes(60, 12)),
    device: { name: "Test Mac", platform: "macos" },
    ...over,
  };
}

export async function registerUser(email: string): Promise<{ token: string; userId: string }> {
  const res = await call("POST", "/v1/register", registerBody(email));
  const r = (await res.json()) as { token: string };
  const { env } = await import("./harness.ts");
  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  return { token: r.token, userId: u!.id };
}

export const uuid = (): string => crypto.randomUUID();
