import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/.claude/**', '**/dist/**', '**/node_modules/**'],
    coverage: { provider: 'v8', reportsDirectory: 'coverage' },
  },
});
