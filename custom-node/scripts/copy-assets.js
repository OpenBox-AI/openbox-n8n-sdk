#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Post-build asset copier. Copies the icon into the compiled node folder.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_ICON = path.join(ROOT, 'assets', 'OB_logomark.png');

const TARGETS = [
  path.join(ROOT, 'dist', 'nodes', 'OpenBoxAgent', 'OB_logomark.png'),
];

if (!fs.existsSync(SRC_ICON)) {
  console.error(`[copy-assets] Source icon not found: ${SRC_ICON}`);
  process.exit(1);
}

for (const dest of TARGETS) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(SRC_ICON, dest);
  console.log(`[copy-assets] ${path.relative(ROOT, dest)}`);
}
