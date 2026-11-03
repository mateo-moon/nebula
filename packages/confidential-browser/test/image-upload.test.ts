import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedImageUploadLimits, imageSizeLabel, imageUploadLimits } from "../src/image-limits";
import { ImageUpload, ImageUploadError } from "../src/service/image-upload";
import { uploadEncryptedImage } from "../src/ui/upload";

const digest = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
function temporary(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "nebula-image-upload-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const status = (code: number) => (error: unknown) => error instanceof ImageUploadError && error.status === code;

test("attested limits support exactly 4 GiB and reject unbounded or incompatible transfer settings", () => {
  const limits = imageUploadLimits(4096);
  assert.equal(limits.maxBytes, 2 ** 32);
  assert.equal(limits.chunkBytes, 8 * 1024 * 1024);
  assert.equal(imageSizeLabel(limits.maxBytes), "4 GiB");
  assert.deepEqual(checkedImageUploadLimits(limits), limits);
  for (const size of [0, -1, 4097, NaN, Infinity, 1.5]) assert.throws(() => imageUploadLimits(size));
  for (const value of [undefined, { ...limits, maxBytes: limits.maxBytes + 1 }, { ...limits, chunkBytes: 2 ** 32 },
    { ...limits, jobTimeoutMs: Infinity }, { ...limits, extra: true }]) assert.throws(() => checkedImageUploadLimits(value));
  temporary(directory => {
    const upload = new ImageUpload(directory, limits);
    assert.equal(upload.begin(2 ** 32).size, 2 ** 32);
    assert.equal(statSync(join(directory, "image.tar.part")).size, 0, "The declared size does not allocate a whole archive");
    assert.throws(() => upload.begin(2 ** 32 + 1), status(413));
    for (const size of [undefined, "4294967296", -1, 0, NaN, 1.5]) assert.throws(() => upload.begin(size), status(400));
  });
});

test("chunks are bounded, ordered and checked; retries cannot substitute another same-sized archive", () => temporary(directory => {
  const limits = imageUploadLimits(4096), first = Buffer.alloc(limits.chunkBytes, 0x51), tail = Buffer.alloc(17, 0x19);
  let upload = new ImageUpload(directory, limits);
  upload.begin(first.length + tail.length);
  assert.equal(upload.complete(), false);
  assert.throws(() => upload.chunk(first.length, tail, digest(tail)), status(409));
  assert.throws(() => upload.chunk(0, first, "0".repeat(64)), status(400));
  assert.throws(() => upload.chunk(0, Buffer.alloc(limits.chunkBytes + 1), undefined), status(409));
  assert.equal(upload.chunk(0, first, digest(first)).received, first.length);
  assert.equal(upload.chunk(0, first, digest(first)).received, first.length, "An identical replay is idempotent");
  const changed = Buffer.alloc(first.length, 0x52);
  assert.throws(() => upload.chunk(0, changed, digest(changed)), status(409));
  assert.throws(() => upload.begin(first.length + tail.length + 1), status(409));
  appendFileSync(join(directory, "image.tar.part"), "uncommitted interrupted write");
  upload = new ImageUpload(directory, limits);
  upload.begin(first.length + tail.length);
  assert.equal(statSync(join(directory, "image.tar.part")).size, first.length);
  assert.equal(upload.chunk(first.length, tail, digest(tail)).complete, true);
  assert.equal(upload.complete(), true);
  assert.equal(existsSync(join(directory, "image.tar.part")), false);
  assert.deepEqual(readFileSync(join(directory, "image.tar")), Buffer.concat([first, tail]));
  assert.equal(statSync(join(directory, "image.tar")).mode & 0o777, 0o600);
  assert.equal(upload.chunk(0, first, digest(first)).complete, true, "A completed upload also permits a byte-identical retry");
  assert.throws(() => upload.chunk(first.length + tail.length, tail, digest(tail)), status(409));
}));

for (const size of [257 * 1024 * 1024 + 13, ...(process.env.LARGE_IMAGE_UPLOAD_TEST === "1" ? [2 ** 32] : [])]) {
  test(`the browser upload loop transfers ${size} bytes with bounded bodies and 64-bit offsets`, { timeout: 180_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "nebula-large-upload-"));
    try {
      const limits = imageUploadLimits(4096), upload = new ImageUpload(directory, limits);
      let largestBody = 0, progress = 0, calls = 0;
      // Generate one chunk at a time; exercising the 4 GiB boundary must not
      // allocate a 4 GiB ArrayBuffer in the browser or in this test process.
      const archive = { size, slice: (start: number, end: number) => new Blob([Buffer.alloc(end - start, Math.floor(start / limits.chunkBytes) % 256)]) } as Blob;
      const image = { version: 2 as const, manifest: "e30=", config: "e30=", manifestDigest: "sha256:" + "0".repeat(64),
        layers: [{ name: "layer-0.enc", size, digest: "sha256:" + "0".repeat(64), file: archive }] };
      await uploadEncryptedImage(image, limits, async (path, method, body, headers) => {
        if (method === "POST") { assert.equal(JSON.parse(body as string).version, 2); upload.begin(size); }
        else {
          const raw = Buffer.from(body as ArrayBuffer);
          largestBody = Math.max(largestBody, raw.length); calls++;
          upload.chunk(Number(path.split("/").at(-1)), raw, headers!["X-Nebula-Chunk-Sha256"]);
        }
        return new Response("{}");
      }, sent => { assert.ok(sent >= progress); progress = sent; });
      assert.equal(progress, size);
      assert.equal(statSync(join(directory, "image.tar")).size, size);
      assert.equal(largestBody, limits.chunkBytes);
      assert.equal(calls, Math.ceil(size / limits.chunkBytes));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("the browser rejects oversize archives before sending any request", async () => {
  await assert.rejects(uploadEncryptedImage({ version: 2, manifest: "", config: "", manifestDigest: "", layers: [{ name: "layer-0.enc", digest: "sha256:" + "0".repeat(64), size: 2 ** 32 + 1, file: { size: 2 ** 32 + 1 } as Blob }] }, imageUploadLimits(4096), async () => {
    assert.fail("Oversize data reached the transport");
  }, () => {}), /limit/);
});
