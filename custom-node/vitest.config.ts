import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the n8n custom-node package.
 *
 * Tests live under `tests/` and exercise pure helpers extracted from
 * the node implementations (verdict routing, HMAC verification,
 * credential normalization). Anything that requires the full n8n
 * runtime — execute(), webhook() — is intentionally out of scope; the
 * upstream `n8n-workflow` package does not ship a test harness for
 * those entry points and mocking it produces brittle tests with low
 * signal.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Limit globs so vitest doesn't accidentally pick up the demo
    // workflow JSON or the seed scripts when invoked from the parent
    // monorepo.
    exclude: ['node_modules/**', 'dist/**'],
    // Tests are fast and synchronous; running serially makes failure
    // output predictable in CI logs.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
