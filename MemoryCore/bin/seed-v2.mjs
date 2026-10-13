#!/usr/bin/env node

// Thin launcher: seed-v2 feeds historical conversations into the memory-tencentdb gateway via the v2 API.
//
// Prefers the precompiled artifact (production); falls back to running the source via tsx when it is not found (development).
//
// Build: npm run build:seed-v2
// Usage:
//   npm run seed-v2 -- --input ./scripts/seed-v2/fixtures/minimal.json
//   node ./bin/seed-v2.mjs --input fixture.json --endpoint http://127.0.0.1:18420

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(thisDir, "../scripts/seed-v2/dist/seed-v2.js");
const srcEntry  = path.resolve(thisDir, "../scripts/seed-v2/seed-v2.ts");

if (fs.existsSync(distEntry)) {
  // Precompiled artifact exists: dynamic import directly
  await import(pathToFileURL(distEntry).href);
} else if (fs.existsSync(srcEntry)) {
  // Not compiled: fall back to tsx (common during development)
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", srcEntry, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
} else {
  console.error("❌  neither dist nor source found:");
  console.error("    " + distEntry);
  console.error("    " + srcEntry);
  console.error("    run: npm run build:seed-v2");
  process.exit(1);
}
