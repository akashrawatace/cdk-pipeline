  import tseslint from "@typescript-eslint/eslint-plugin";
  import tsparser from "@typescript-eslint/parser";
  import prettierPlugin from "eslint-plugin-prettier";
  import prettierConfig from "eslint-config-prettier";

  export default [
    {
      files: ["**/*.ts"],

      languageOptions: {
        parser: tsparser,
        sourceType: "module",
      },

      plugins: {
        "@typescript-eslint": tseslint,
        prettier: prettierPlugin,
      },

      rules: {
        ...tseslint.configs.recommended.rules,

        // 1. Let Prettier handle formatting rules entirely
        ...prettierConfig.rules,
        "prettier/prettier": "error",

        // 2. Code quality rules (put these AFTER prettierConfig to be safe)
        "@typescript-eslint/no-unused-vars": "warn",
        "no-console": "warn",

        // REMOVED: 'quotes' and 'semi' rules.
        // Prettier handles these natively via your .prettierrc file.
      },
    },
  ];
