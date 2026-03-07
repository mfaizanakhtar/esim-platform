import path from 'path';

export default {
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,

    // Integration tests only - these hit the real FiRoam API and place real orders
    // Required env vars: FIROAM_PHONE, FIROAM_PASSWORD, FIROAM_SIGN_KEY
    // Required flags:    FIROAM_INTEGRATION=true (and FIROAM_E2E_ORDERS=true for order placement)
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules', 'dist'],

    // No coverage for integration tests
    coverage: {
      enabled: false,
    },

    // Long timeout - real API calls can be slow
    testTimeout: 60000,
    hookTimeout: 30000,

    // Run sequentially - integration tests place real orders, avoid race conditions
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
};
