import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["dist/**", "node_modules/**"],
  rules: {
    "oxc/no-accumulating-spread": "error",
  },
});
