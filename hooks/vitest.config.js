/**
 * Vitest config for the OpenBox external hooks. Loaded as
 * CommonJS — the hook files themselves are CommonJS, and we want
 * the test runtime to match.
 */
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs}'],
    environment: 'node',
    exclude: ['node_modules/**'],
  },
});
