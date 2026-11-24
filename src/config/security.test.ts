import { describe, it, expect } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  safeEqual,
} from "./security.js";

describe("Security", () => {
  describe("generateApiKey", () => {
    it("gera chave com prefixo oc_ e 40 caracteres hex", () => {
      const key = generateApiKey();
      expect(key).toMatch(/^oc_[0-9a-f]{40}$/);
    });

    it("gera chaves únicas", () => {
      const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
      expect(keys.size).toBe(100);
    });
  });

  describe("hashApiKey", () => {
    it("retorna hash determinístico para a mesma chave", () => {
      const key = generateApiKey();
      expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it("retorna hash diferente para chaves diferentes", () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(hashApiKey(key1)).not.toBe(hashApiKey(key2));
    });
  });

  describe("safeEqual", () => {
    it("retorna true para strings iguais", () => {
      expect(safeEqual("abc", "abc")).toBe(true);
    });

    it("retorna false para strings diferentes", () => {
      expect(safeEqual("abc", "abd")).toBe(false);
    });

    it("retorna false para tamanhos diferentes", () => {
      expect(safeEqual("abc", "abcd")).toBe(false);
    });
  });

  describe("encryptSecret / decryptSecret", () => {
    it("criptografa e descriptografa corretamente", () => {
      const secret = "minha-chave-secreta-da-meta";
      const encrypted = encryptSecret(secret);
      expect(encrypted).not.toBe(secret);
      expect(decryptSecret(encrypted)).toBe(secret);
    });

    it("produz ciphertext diferente a cada chamada (IV aleatório)", () => {
      const secret = "teste";
      const e1 = encryptSecret(secret);
      const e2 = encryptSecret(secret);
      expect(e1).not.toBe(e2);
      expect(decryptSecret(e1)).toBe(secret);
      expect(decryptSecret(e2)).toBe(secret);
    });
  });
});
