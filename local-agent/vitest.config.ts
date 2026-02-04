import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Focus on security-critical files first (Grandfathering clause)
      include: ['src/task-executor.ts'],
      thresholds: {
        // task-executor.ts is security-critical
        // Note: functions threshold lowered because claude-code/codex are placeholders
        'src/task-executor.ts': {
          lines: 80,
          functions: 70, // Allow for placeholder functions
          branches: 60,
          statements: 80,
        },
      },
    },
  },
});
