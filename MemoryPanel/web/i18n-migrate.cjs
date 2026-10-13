#!/usr/bin/env node
/**
 * i18n migration script — replaces hard-coded Chinese strings in JSX/TSX with t() calls
 * 
 * This script does a minimal pattern-based replacement and does not aim to be perfect.
 * Manual review and adjustment are still required afterwards.
 */
const fs = require('fs');
const path = require('path');

// Recursively walk the directory and find all .ts/.tsx files
function walk(dir) {
  let results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else if (item.endsWith('.tsx') || item.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const srcDir = path.join(__dirname, 'MemoryPanel', 'web', 'src');
const files = walk(srcDir).filter(f => 
  !f.includes('i18n/') && 
  !f.includes('node_modules') &&
  !f.endsWith('.css')
);

let totalReplacements = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let modified = false;
  let count = 0;

  // Check whether the file already imports useTranslation
  const hasChinese = /[\u4e00-\u9fff]/.test(content);
  if (!hasChinese) continue;

  // ... (rest of script would go here)
  // This is a placeholder - actual migration done manually per file
  
  if (modified) {
    fs.writeFileSync(file, content);
    totalReplacements += count;
  }
}

console.log(`Done. ${totalReplacements} replacements.`);
