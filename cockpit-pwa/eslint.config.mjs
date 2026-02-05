import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Relax React 19 strict rules for valid patterns
  {
    rules: {
      // Allow setState in useEffect for debounce/sync patterns
      "react-hooks/set-state-in-effect": "warn",
      // Allow ref updates in render for performance patterns
      "react-hooks/refs": "warn",
      // Allow ref access before declaration for self-referencing patterns
      "react-hooks/immutability": "warn",
    },
  },
]);

export default eslintConfig;
