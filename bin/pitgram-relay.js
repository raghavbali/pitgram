#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundledRelay = join(packageRoot, "relay");
const relayRoot = join(homedir(), ".pi", "agent", "pitgram-relay");
mkdirSync(relayRoot, { recursive: true });
for (const path of ["schema.js", "package.json", "handlers", "lib", "docs"]) {
  cpSync(join(bundledRelay, path), join(relayRoot, path), { recursive: true, force: true });
}
const cli = require.resolve("@tgcloud/cli/bin/tgcloud.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: relayRoot,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
