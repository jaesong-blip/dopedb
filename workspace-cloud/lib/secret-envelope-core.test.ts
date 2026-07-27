import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeEnvelopeKey,
  openEnvelope,
  sealEnvelope,
} from "./secret-envelope-core";

describe("provider credential envelope", () => {
  it("round-trips only with the same record context", () => {
    const key = randomBytes(32);
    const envelope = sealEnvelope(key, "oauth-token", "integration:a");
    expect(openEnvelope(key, envelope, "integration:a")).toBe("oauth-token");
    expect(() => openEnvelope(key, envelope, "integration:b")).toThrow();
  });

  it("rejects tampering and keys with the wrong size", () => {
    const key = randomBytes(32);
    const envelope = sealEnvelope(key, "oauth-token", "integration:a");
    const parts = envelope.split(".");
    const ciphertext = Buffer.from(parts[2], "base64url");
    ciphertext[0] ^= 0x01;
    parts[2] = ciphertext.toString("base64url");
    expect(() => openEnvelope(key, parts.join("."), "integration:a")).toThrow();
    expect(() => sealEnvelope(randomBytes(16), "value", "context")).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("rejects a non-canonical base64url spelling of authenticated bytes", () => {
    const key = randomBytes(32);
    const parts = sealEnvelope(key, "oauth-token", "integration:a").split(".");
    const tag = Buffer.from(parts[3]!, "base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const replacement = [...alphabet].find((candidate) => {
      const encoded = `${parts[3]!.slice(0, -1)}${candidate}`;
      return encoded !== parts[3] && Buffer.from(encoded, "base64url").equals(tag);
    });
    expect(replacement).toBeDefined();
    parts[3] = `${parts[3]!.slice(0, -1)}${replacement}`;
    expect(() => openEnvelope(key, parts.join("."), "integration:a"))
      .toThrow("Invalid credential envelope");
  });

  it("accepts only canonical 32-byte base64url deployment keys", () => {
    const encoded = randomBytes(32).toString("base64url");
    expect(decodeEnvelopeKey(encoded)).toHaveLength(32);
    expect(() => decodeEnvelopeKey(`${encoded}=`)).toThrow(/canonical/);
    expect(() => decodeEnvelopeKey(`${encoded.slice(0, -1)}!`)).toThrow(/canonical/);
  });
});
