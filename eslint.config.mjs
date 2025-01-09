import globals from 'globals';
import pluginJs from '@eslint/js';

export default [
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    languageOptions: { globals: globals.browser },
  },
  pluginJs.configs.recommended,
  {
    ignores: [
      '**/node_modules/**',  // Ignore node_modules folder
      '**/dist/**',          // Ignore dist folder
      '**/build/**',         // Ignore build folder
      '**/*.min.js',         // Ignore minified files
      '**/src/**/*.test.js', // Optionally ignore test files, if needed
      '**/src/**/*.spec.js'  // Optionally ignore spec files
    ],
  },
];