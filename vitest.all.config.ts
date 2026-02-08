import { defineConfig } from 'vitest/config';

// Full-repo test suite. This may include long-running or flaky tests from vendored code.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});

