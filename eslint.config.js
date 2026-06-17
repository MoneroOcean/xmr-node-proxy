"use strict";
const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" }],
      // Intentional ANSI escape sequence handling in test output stripping; the ESC control char is required.
      "no-control-regex": "off"
    }
  }
];
