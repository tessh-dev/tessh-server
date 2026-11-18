#!/usr/bin/env node
import { runCli } from "./cli.ts";
import { start } from "./app.ts";
import { ConfigError } from "./config.ts";

try {
  const code = runCli(process.argv.slice(2));
  if (code !== null) process.exit(code);
  const app = await start();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
