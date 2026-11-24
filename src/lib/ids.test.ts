import { describe, it, expect } from "vitest";

import { newId, nowMs } from "./ids.js";

describe("IDs", () => {
  describe("newId", () => {
    it("gera UUIDs válidos (v7)", () => {
      const id = newId();
      // UUID v7: versão 7 no nibble 13
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("gera IDs ordenáveis (monotônicos no tempo)", () => {
      const ids = Array.from({ length: 10 }, () => newId()).sort();
      // IDs gerados sequencialmente devem estar em ordem.
      expect(ids.length).toBe(10);
    });

    it("não gera IDs duplicados", () => {
      const ids = new Set(Array.from({ length: 1000 }, () => newId()));
      expect(ids.size).toBe(1000);
    });
  });

  describe("nowMs", () => {
    it("retorna timestamp em milissegundos", () => {
      const ts = nowMs();
      expect(typeof ts).toBe("number");
      expect(ts).toBeGreaterThan(0);
      expect(String(ts).length).toBeGreaterThanOrEqual(13);
    });
  });
});
