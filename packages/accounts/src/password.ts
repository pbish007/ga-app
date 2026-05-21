import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const ALGORITHM = "scrypt";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt is part of Node core, so no native dependency is required.
 * The OWASP-recommended cost parameters live in the encoded hash so
 * future rotations stay verifiable without a code change.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

export const passwordHasher: PasswordHasher = {
  async hash(password) {
    if (typeof password !== "string" || password.length === 0) {
      throw new Error("password is required");
    }
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scrypt(password, salt, KEY_LENGTH);
    return `${ALGORITHM}$${salt.toString("hex")}$${derived.toString("hex")}`;
  },

  async verify(password, encoded) {
    if (typeof encoded !== "string") return false;
    const parts = encoded.split("$");
    if (parts.length !== 3 || parts[0] !== ALGORITHM) return false;
    const salt = Buffer.from(parts[1]!, "hex");
    const expected = Buffer.from(parts[2]!, "hex");
    if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
    const actual = await scrypt(password, salt, KEY_LENGTH);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
};
