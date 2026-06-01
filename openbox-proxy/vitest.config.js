const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs}'],
    environment: 'node',
    exclude: ['node_modules/**'],
  },
});
