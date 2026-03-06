module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier', 'no-relative-import-paths'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  rules: {
    'prettier/prettier': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': ['warn', { allow: ['error'] }],
  },
  overrides: [
    {
      // Enforce ~ path alias for all src/ files (including tests)
      files: ['src/**/*.ts'],
      rules: {
        'no-relative-import-paths/no-relative-import-paths': [
          'error',
          { allowSameFolder: false, rootDir: 'src', prefix: '~' },
        ],
      },
    },
  ],
};
