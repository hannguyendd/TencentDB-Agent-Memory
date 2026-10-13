/**
 * ESLint configuration
 *
 * For React + TypeScript + Vite projects.
 * Integrates prettier (disables rules that conflict with prettier).
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  settings: {
    'import/resolver': {
      typescript: { project: './tsconfig.json' },
    },
  },
  rules: {
    // Allow any but emit a warning (incremental migration)
    '@typescript-eslint/no-explicit-any': 'warn',
    // Allow unused variables during development (tsc already has noUnusedLocals)
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // React Hooks rules
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // Code style is left to prettier
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
  ignorePatterns: ['dist', 'node_modules', '*.config.js', '*.config.ts'],
};
