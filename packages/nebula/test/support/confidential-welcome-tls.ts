import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

// Minimal test-only ASN.1 wrapping for a fresh local TLS fixture. Signing and key
// generation use Node crypto; this is not a production certificate issuer.
export function fixtureIdentity() {
  const tlv = (tag: number, ...values: Buffer[]): Buffer => {
    const body = Buffer.concat(values), size = body.length;
    assert.ok(size < 65536, "Test fixture DER remains bounded");
    const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >>> 8, size & 255];
    return Buffer.concat([Buffer.from([tag, ...length]), body]);
  };
  const sequence = (...values: Buffer[]) => tlv(0x30, ...values);
  const oid = (hex: string) => tlv(0x06, Buffer.from(hex, "hex"));
  const algorithm = sequence(oid("2a8648ce3d040302")); // ecdsa-with-SHA256
  const name = sequence(tlv(0x31, sequence(oid("550403"), tlv(0x0c, Buffer.from("localhost")))));
  const time = (milliseconds: number) => tlv(0x18,
    Buffer.from(new Date(milliseconds).toISOString().replace(/\D/g, "").slice(0, 14) + "Z"));
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) | 1;
  const extensions = tlv(0xa3, sequence(
    sequence(oid("551d11"), tlv(0x04, sequence(tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1]))))),
    sequence(oid("551d13"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence())),
  ));
  const now = Date.now();
  const tbs = sequence(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), algorithm, name,
    sequence(time(now - 60_000), time(now + 3_600_000)), name,
    pair.publicKey.export({ type: "spki", format: "der" }), extensions);
  const certificate = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, pair.privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  assert.equal(new X509Certificate(certificate).verify(pair.publicKey), true);
  return { key: pair.privateKey.export({ type: "pkcs8", format: "pem" }), cert: pem, der: certificate };
}

