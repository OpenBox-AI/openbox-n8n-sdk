#!/usr/bin/env node
 
/**
 * Post-build asset copier. Copies icons into the compiled node/credential folders.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const copies = [
  // Node icon
  {
    src: path.join(ROOT, 'assets', 'logomark.svg'),
    dest: path.join(ROOT, 'dist', 'nodes', 'OpenBoxAgent', 'openbox.svg'),
  },
  // Credential icon
  {
    src: path.join(ROOT, 'assets', 'logomark.svg'),
    dest: path.join(ROOT, 'dist', 'credentials', 'openbox.svg'),
  },
  // package.json — shared/signing.ts reads its own version via a relative
  // require('../package.json') so the X-OpenBox-SDK-Version header can never
  // drift from the published version. That require resolves relative to the
  // COMPILED file (dist/shared/signing.js → ../package.json = dist/package.json),
  // so the source package.json must be mirrored into dist/ at the same relative
  // depth as shared/signing.ts is from the project root.
  {
    src: path.join(ROOT, 'package.json'),
    dest: path.join(ROOT, 'dist', 'package.json'),
  },
];

for (const { src, dest } of copies) {
  if (!fs.existsSync(src)) {
    console.error(`[copy-assets] Source not found: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-assets] copied → ${path.relative(ROOT, dest)}`);
}
