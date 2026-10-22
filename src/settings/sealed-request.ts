import { createDecipheriv, generateKeyPair, privateDecrypt, constants, type KeyObject } from "node:crypto";
import * as z from "zod/v4";

// Encryption keeps credentials out of host tool arguments/logs. It is NOT user approval.
export const sealedSettingsSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).length(344),
  iv: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).length(16),
  ciphertext: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(24).max(180_000),
});
export type SealedSettingsRequest = z.infer<typeof sealedSettingsSchema>;
const requestSchema = z.strictObject({
  token: z.string().min(16).max(256),
  requestId: z.string().uuid(),
  method: z.enum(["GET", "POST"]),
  path: z.enum(["/api/config", "/api/status", "/api/profiles", "/api/save", "/api/credential", "/api/test", "/api/clear"]),
  body: z.string().max(100_000).optional(),
  headers: z.strictObject({
    "content-type": z.enum(["application/json", "application/octet-stream"]).optional(),
    "x-qq-mail-account-revision": z.string().regex(/^[a-f0-9-]{36,64}$/).optional(),
  }),
});

export class SealedSettingsChannel {
  #keys: Promise<{ privateKey: KeyObject; publicKey: KeyObject }> | undefined;
  #pair() {
    return this.#keys ??= new Promise<{ privateKey: KeyObject; publicKey: KeyObject }>((resolve, reject) => {
      generateKeyPair("rsa", { modulusLength: 2048 }, (error, publicKey, privateKey) => {
        if (error) reject(error); else resolve({ publicKey, privateKey });
      });
    });
  }
  async publicKey(): Promise<string> {
    return (await this.#pair()).publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }
  async open(input: SealedSettingsRequest) {
    const envelope = sealedSettingsSchema.parse(input);
    const key = privateDecrypt({ key: (await this.#pair()).privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.key, "base64"));
    let plain: Buffer | undefined;
    try {
      if (key.length !== 32) throw new Error("Invalid key");
      const encrypted = Buffer.from(envelope.ciphertext, "base64");
      if (encrypted.length < 16 || encrypted.length > 130_000) throw new Error("Invalid envelope size");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from("qq-mail-settings-v1"));
      decipher.setAuthTag(encrypted.subarray(-16));
      plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      return requestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)));
    } finally { key.fill(0); plain?.fill(0); }
  }
}
