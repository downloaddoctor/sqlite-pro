const js = require('@eslint/js')
const tseslint = require('typescript-eslint')

module.exports = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        WebAssembly: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
      'no-unreachable': 'off',
      'no-control-regex': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'temp/', 'worktemp/', 'docs/', 'dist/', 'bench/'],
  },
]
