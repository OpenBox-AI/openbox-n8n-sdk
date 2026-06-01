#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Post-build asset copier.
 *
 * n8n resolves icon paths declared as `file:OB_logomark.png` relative
 * to the compiled node's JS file. Because we now ship multiple nodes
 * in nested directories (`dist/nodes/OpenBox/`,
 * `dist/nodes/OpenBoxTrigger/`) the icon must be present in every
 * node folder, not just at `dist/`.
 *
 * Keeping this as a tiny Node script (vs. a shelled-out `cp`) means
 * it works identically on Linux CI, the Alpine builder image, and on
 * Windows developer machines without needing cross-env/cpx.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_ICON = path.join(ROOT, 'assets', 'OB_logomark.png');

const TARGETS = [
  path.join(ROOT, 'dist', 'OB_logomark.png'),
  path.join(ROOT, 'dist', 'nodes', 'OpenBox', 'OB_logomark.png'),
  path.join(ROOT, 'dist', 'nodes', 'OpenBoxTrigger', 'OB_logomark.png'),
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
