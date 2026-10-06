import { createCipheriv } from "node:crypto";

const APPLE_VNC_PASSWORD_KEY = Buffer.from("1734516E8BA8C5E2FF1C39567390ADCA", "hex");

export function encodeAppleVncPassword(password: string | Uint8Array): Buffer {
  const bytes = typeof password === "string" ? Buffer.from(password, "utf8") : Buffer.from(password);
  if (bytes.length === 0 || bytes.length > 8) throw new Error("Apple legacy VNC password must be 1-8 UTF-8 bytes");
  const encoded = Buffer.alloc(16);
  bytes.copy(encoded);
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = encoded[index]! ^ APPLE_VNC_PASSWORD_KEY[index]!;
  }
  return Buffer.from(encoded.toString("hex").toUpperCase(), "ascii");
}

function reverseBits(byte: number): number {
  let value = byte;
  value = ((value & 0xf0) >>> 4) | ((value & 0x0f) << 4);
  value = ((value & 0xcc) >>> 2) | ((value & 0x33) << 2);
  return ((value & 0xaa) >>> 1) | ((value & 0x55) << 1);
}

export function vncChallengeResponse(password: string | Uint8Array, challenge: Buffer): Buffer {
  if (challenge.length !== 16) throw new Error("VNC challenge must be exactly 16 bytes");
  const passwordBytes = typeof password === "string" ? Buffer.from(password, "utf8") : Buffer.from(password);
  const key = Buffer.alloc(8);
  passwordBytes.copy(key, 0, 0, Math.min(passwordBytes.length, 8));
  for (let index = 0; index < key.length; index += 1) key[index] = reverseBits(key[index]!);

  // EDE with the same key three times is equivalent to single DES, while remaining
  // available in OpenSSL 3 where the legacy single-DES cipher may be disabled.
  const key24 = Buffer.concat([key, key, key]);
  const cipher = createCipheriv("des-ede3", key24, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}
