/**
 * Geração de IDs UUIDv7 (RFC 9562) sem dependências externas.
 * UUIDv7 mantém ordenação cronológica — ideal para índices e ordenação.
 */

const MAX_RANDOM = 0x3fff_ffff_ffff_ffffn;

/** Gera um UUID v7 como string canônica. */
export function newId(): string {
  const timestamp = BigInt(Date.now()) & 0xffff_ffff_ffffn;
  const randA = BigInt(Math.floor(Math.random() * 0x1000));
  const randB = BigInt(Math.floor(Math.random() * 0x1_0000_0000)) & 0xffff_ffffn;
  const randC = BigInt(Math.floor(Math.random() * 0x1_0000_0000)) & 0xffff_ffffn;

  // 48 bits timestamp | 4 bits versão (0111) | 12 bits randA
  const high = (timestamp << 16n) | (7n << 12n) | randA;
  // 2 bits variante (10) | 62 bits rand
  const low = (0x8000_0000_0000_0000n | (randB << 32n) | randC) & MAX_RANDOM;

  const hexHigh = high.toString(16).padStart(16, "0");
  const hexLow = low.toString(16).padStart(16, "0");

  return [
    hexHigh.slice(0, 8),
    hexHigh.slice(8, 12),
    hexHigh.slice(12, 16),
    hexLow.slice(0, 4),
    hexLow.slice(4, 16),
  ].join("-");
}

/** Timestamp em milissegundos (para colunas `created_at`/`updated_at`). */
export function nowMs(): number {
  return Date.now();
}
