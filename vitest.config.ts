import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // WHY this is root-level: Vitest 4 evaluates the no-files result before
    // applying nested project options. An empty system tier is valid while its
    // first process-boundary scenarios are being added, but the public command
    // contract must remain green and independently runnable.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.system.test.ts', 'src/**/*.live.test.ts'],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['src/**/*.system.test.ts'],
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // WHY this is explicit: imported-files-only coverage rewards missing
      // tests by omitting untouched production modules from the denominator.
      include: ['src/**/*.ts'],
      // WHY thresholds begin at today's whole-number floor: coverage work can
      // land incrementally, but deleting or bypassing existing assertions can
      // no longer remain green. Each new test PR should ratchet these upward.
      thresholds: { statements: 14, branches: 10, functions: 14, lines: 15 },
    },
  },
})
