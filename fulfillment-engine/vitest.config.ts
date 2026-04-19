import path from 'path';

export default {
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // Test environment
    environment: 'node',

    // Enable global test APIs (describe, it, expect, etc.)
    globals: true,

    // Test file patterns
    // Unit tests (__tests__/) and component tests (*.component.test.ts)
    // For integration tests run: npm run test:integration
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.component.test.ts'],
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
        'src/queue/**', // Queue bootstrap wrappers (integration-covered)
        'src/vendor/types.ts', // Type-only contracts
      ],

      // Coverage thresholds - CI will fail if coverage drops below these
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 65,
        statements: 75,
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
