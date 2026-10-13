#!/usr/bin/env node

// Thin launcher: loads the precompiled local Memory data query script.
// Build: npm run build:read-local-memory
// Usage: npm run read-local-memory -- [args]  or  node ./bin/read-local-memory.mjs [args]

import path from "node:path";
import { fileURLToPath } from "node:url";

import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../scripts/read-local-memory/dist/read-local-memory.js");

if (!fs.existsSync(entryScript)) {
  console.error("❌  Precompiled artifact not found: " + entryScript);
  console.error("   Please run first: npm run build:read-local-memory");
  process.exit(1);
}

import(entryScript);
