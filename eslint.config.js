import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Flat config: a later block with the same rule replaces it for overlapping files, so each
// boundary block carries the held-out pattern itself.
const heldout = { group: ["**/heldout*"], message: "Held-out grader fixtures are loaded only by scripts/eval.ts." };

const banNodeAndApp = {
  patterns: [
    { group: ["node:*"], message: "src/core is pure: no Node built-ins." },
    { group: ["fs", "path", "os", "child_process", "crypto", "http", "https"], message: "src/core is pure: no Node modules." },
    { group: ["react", "react-dom", "react/*"], message: "src/core is pure: no React." },
    { group: ["**/cli/**", "../../cli/*"], message: "src/core may not import the CLI." },
    { group: ["../pages/*", "../components/*", "../state/*", "../App*"], message: "src/core may not import the viewer." },
    heldout,
  ],
};

// Globals src/core may not touch, banned both bare (no-restricted-globals) and through a global
// object alias such as globalThis.fetch or window.Date (no-restricted-properties).
const coreBannedGlobals = [
  { name: "Date", message: "core never reads a clock; times are supplied data." },
  { name: "fetch", message: "core does no I/O." },
  { name: "process", message: "core does not read the environment." },
  { name: "performance", message: "core never reads a clock." },
];
const globalObjectAliases = ["globalThis", "self", "window"];
const coreBannedAliasProperties = globalObjectAliases.flatMap((object) =>
  coreBannedGlobals.map(({ name, message }) => ({ object, property: name, message })),
);

export default tseslint.config(
  { ignores: ["dist/**", "dist-cli/**", "out/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", banNodeAndApp],
      "no-restricted-globals": ["error", ...coreBannedGlobals],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "use evalkit/prng mulberry32 with a seed." },
        ...coreBannedAliasProperties,
      ],
    },
  },
  {
    files: ["src/**/*.tsx", "src/**/*.ts"],
    ignores: ["src/core/**"],
    languageOptions: { globals: globals.browser },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "18.3" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react/no-danger": "error",
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/cli/**", "node:*"], message: "The viewer may not import the CLI or Node modules." }, heldout] },
      ],
    },
  },
  {
    files: ["cli/**/*.ts", "scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["cli/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [heldout] }] },
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [heldout] },
      ],
    },
  },
);
