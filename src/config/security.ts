import crypto from "node:crypto";

import { getEnv } from "./env.js";

/**
 * Utilitários de segurança: hash de API keys, criptografia simétrica de
 * credenciais e comparação em tempo constante.
 */

const AES_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** Deriva uma chave de 32 bytes a partir da string de ambiente. */
function getEncryptionKey(): Buffer {
  const raw = getEnv().ENCRYPTION_KEY;
  // Aceita tanto base64 quanto string arbitrária.
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  } catch {
    // fallthrough
  }
  return crypto.scryptSync(raw, "odonto-class-encryption-salt", 32);
}

/** Hash de API key (SHA-256 + pepper). Nunca armazena a chave em texto puro. */
export function hashApiKey(plainKey: string): string {
  const pepper = getEnv().API_KEY_PEPPER;
  return crypto.createHash("sha256").update(`${pepper}:${plainKey}`).digest("hex");
}

/** Gera uma nova API key no formato `oc_<40 hex>`. */
export function generateApiKey(): string {
  return `oc_${crypto.randomBytes(20).toString("hex")}`;
}

/** Criptografa credenciais sensíveis (ex.: access token da Meta por tenant). */
export function encryptSecret(plain: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Formato: iv:authTag:ciphertext (base64)
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** Descriptografa credenciais. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Formato de credencial criptografada inválido.");
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Comparação em tempo constante para evitar timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Gera um token hexadecimal aleatório. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
