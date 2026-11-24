import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Configuração ESLint (flat config) da API WhatsApp.
 * Compatível com ESM ("type": "module") e com o código TypeScript 5.9.
 */
export default tseslint.config(
  {
    // Artefatos de build, migrations e scripts locais não são analisados.
    ignores: ["dist/**", "node_modules/**", "drizzle/**", "coverage/**", ".local/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // O projeto usa prefixo `_` para parâmetros intencionalmente não usados.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
