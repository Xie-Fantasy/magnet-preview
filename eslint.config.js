import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['src/domain/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'chrome',
          message: 'Domain contracts must not depend on Chrome APIs.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                '../entrypoints/**',
                '../../entrypoints/**',
              ],
              message:
                'Domain contracts must not depend on React or presentation.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/content/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../entrypoints/**', '../../entrypoints/**'],
              message:
                'Scanner modules must not depend on Popup or other presentation entrypoints.',
            },
          ],
        },
      ],
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: 'readonly',
        defineBackground: 'readonly',
      },
    },
  },
  {
    files: [
      'src/entrypoints/{popup,my}/**/*.{ts,tsx}',
      'src/content/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '@/infrastructure/**'],
              message:
                'Presentation and content modules must use application contracts, never infrastructure adapters.',
            },
          ],
        },
      ],
    },
  },
  // Entrypoint roots compose infrastructure behind application contracts.
  {
    files: ['src/entrypoints/{popup,my}/main.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
