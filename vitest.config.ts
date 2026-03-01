export default {
  test: {
    // Test environment
    environment: 'node',

    // Enable global test APIs (describe, it, expect, etc.)
    globals: true,

    // Test file patterns
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', 'scripts'],

    // Coverage configuration
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',

      // Files to include in coverage
      include: ['src/**/*.ts'],

      // Files to exclude from coverage
      exclude: [
        'node_modules/',
        'dist/',
        'scripts/',
        'prisma/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/tests/**',
        'src/index.ts', // Entry point
        'src/worker/index.ts', // Entry point
        'src/server.ts', // Server setup
      ],

      // Coverage thresholds - adjusted to match current test coverage
      // TODO: Increase these as more tests are added
      thresholds: {
        lines: 25,
        functions: 25,
        branches: 35,
        statements: 25,
      },

      // Show all files, even those with 0% coverage
      all: true,
    },

    // Test timeout
    testTimeout: 15000,
    hookTimeout: 15000,

    // Concurrent tests
    pool: 'threads',
    maxWorkers: 4,
    minWorkers: 1,

    // Mock configuration
    mockReset: true,
    clearMocks: true,
    restoreMocks: true,
  },
};
