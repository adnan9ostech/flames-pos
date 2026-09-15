import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";

/*
 * `no-undef` is the rule this codebase most needed and did not have.
 *
 * This is plain JavaScript with no type checker, and eslint-config-next leaves
 * no-undef off because it assumes TypeScript is catching it. Nothing was. The
 * shape that kept getting through is a `const` declared inside the try{} that
 * authenticates and then read in the block after it — block-scoped, so the
 * reference is to nothing, and the build compiles it happily because it is
 * syntactically perfect. It reaches production as a 500 or an empty screen.
 *
 * It shipped three times: /api/orders went down with it, and both the gross
 * profit and menu analytics reports were broken by it DURING the audit that
 * found the pattern. Proven against a probe reproducing the /api/orders case:
 * this rule catches it, and the config without it does not. Turning it on cost
 * nothing — src, tests and scripts were already clean.
 *
 * The globals list is what tells the rule which free names are real: the
 * browser's for components, Node's for server code and scripts, and the
 * shared ES built-ins.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.es2024 },
    },
    rules: { "no-undef": "error" },
  },
]);

export default eslintConfig;
