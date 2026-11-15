import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "playwright-report", "test-results", "research", "drizzle"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // The Scriptable widget runs in Scriptable's JavaScriptCore runtime (https://docs.scriptable.app).
    files: ["scriptable/*.js"],
    languageOptions: {
      globals: Object.fromEntries(
        ["Alert", "Color", "DrawContext", "FileManager", "Font", "Keychain", "ListWidget", "Path", "Point", "Request", "SFSymbol", "Script", "Size", "URLScheme", "config"].map(
          (name) => [name, "readonly"],
        ),
      ),
    },
  },
);
