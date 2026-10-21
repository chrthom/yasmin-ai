import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
});

export default [
  {
    ignores: ['projects/**/*']
  },
  ...compat.extends('eslint:recommended', 'plugin:@typescript-eslint/recommended').map(config => ({
    ...config,
    files: ['**/*.ts']
  })),
  {
    files: ['**/*.ts'],

    rules: {
      'linebreak-style': ['error', 'unix'],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['warn'],
      '@typescript-eslint/no-explicit-any': ['off']
    }
  },
  // TSDoc unit comments are required on every function, class, and arrow-function constant
  // (see AGENTS.md "Comment convention"). Tests are exempt: test scaffolding is only commented
  // where behavior is genuinely non-obvious.
  {
    files: ['**/*.ts'],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          contexts: [
            'FunctionDeclaration',
            'ClassDeclaration',
            'MethodDefinition',
            'VariableDeclarator > ArrowFunctionExpression'
          ]
        }
      ]
    }
  },
  {
    files: ['**/__tests__/**/*.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off'
    }
  }
];
