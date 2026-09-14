import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    ignores: ['node_modules/', 'coverage/'],
  },
  {
    files: ['src/**/*.js', '__tests__/**/*.js', 'bin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
]
