#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- Node postinstall script uses CommonJS require */
/**
 * npm sometimes installs a broken `node_modules/.bin/tsc` that does
 * `require('../lib/tsc.js')` (resolves to `node_modules/lib/`, not TypeScript).
 * Recreate the standard symlink to `typescript/bin/tsc`.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const binPath = path.join(root, "node_modules", ".bin", "tsc");
const targetPath = path.join(root, "node_modules", "typescript", "bin", "tsc");

if (!fs.existsSync(targetPath)) {
  process.exit(0);
}

try {
  let needsFix = false;
  if (!fs.existsSync(binPath)) {
    needsFix = true;
  } else {
    const st = fs.lstatSync(binPath);
    if (st.isSymbolicLink()) {
      process.exit(0);
    }
    const content = fs.readFileSync(binPath, "utf8");
    if (content.includes("require('../lib/tsc.js')") && !content.includes("typescript")) {
      needsFix = true;
    }
  }
  if (!needsFix) process.exit(0);
  try {
    fs.unlinkSync(binPath);
  } catch {
    /* ignore */
  }
  fs.symlinkSync(path.relative(path.dirname(binPath), targetPath), binPath);
} catch (e) {
  console.warn("[fix-tsc-bin] failed:", e.message);
  process.exit(0);
}
