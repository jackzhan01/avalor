/**
 * UUID generation.
 *
 * UUIDs (not server-assigned autoincrement ids) are what will make a future
 * backend sync cheap: a record created offline on a phone can be pushed to the
 * server as-is, with no id remapping.
 *
 * The fallback is load-bearing, not defensive padding. `crypto.randomUUID` is
 * only exposed in a SECURE CONTEXT. Vercel is HTTPS so production is fine, but
 * testing on a real phone over `http://<lan-ip>:3000` is NOT a secure context,
 * and without this fallback the very first tap would throw.
 */

function randomBytes16(): Uint8Array {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  // Last resort: no Web Crypto at all. Ids only need to be locally unique.
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function uuidFromBytes(bytes: Uint8Array): string {
  // RFC 4122 version 4 / variant 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidFromBytes(randomBytes16());
}
