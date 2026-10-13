#!/usr/bin/env node

// Thin launcher: loads the precompiled VDB export script.
// Build: npm run build:export-vdb
// Usage: npm run export:vdb -- [args]  or  node ./bin/export-tencent-vdb.mjs [args]

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../scripts/export-tencent-vdb/dist/export-tencent-vdb.js");

if (!fs.existsSync(entryScript)) {
  console.error("❌  Precompiled artifact not found: " + entryScript);
  console.error("   Please run first: npm run build:export-tencent-vdb");
  process.exit(1);
}

import(entryScript);
