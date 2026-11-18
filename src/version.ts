// The server's version, read from package.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function version(): string {
  try {
    return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}
