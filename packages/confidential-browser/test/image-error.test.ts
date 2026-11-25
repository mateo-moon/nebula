import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImageError, imageWorkerError } from "../src/ui/image-error";

test("only exact reviewed messages and fixed worker codes produce actionable image diagnostics", () => {
  assert.equal(classifyImageError(new Error("A valid linux/amd64 image is required")).code, "IMAGE_PLATFORM_UNSUPPORTED");
  assert.equal(classifyImageError(new Error("Image metadata exceeds 1 MiB")).code, "IMAGE_METADATA_LIMIT");
  assert.equal(classifyImageError(new Error("Encrypted image metadata exceeds 1 MiB")).code, "IMAGE_METADATA_LIMIT");
  assert.match(classifyImageError(new Error("Image metadata exceeds 1 MiB")).message, /1 MiB.*separate/);
  assert.equal(classifyImageError(new DOMException("private-sentinel", "NotReadableError")).code, "IMAGE_STORAGE_UNAVAILABLE");
  for (const error of [new Error("private-sentinel A valid linux/amd64 image is required"), new Error("private-sentinel"),
    new SyntaxError("private-sentinel from a corrupt local receipt"),
    { get message() { throw new Error("private-sentinel"); } }, { get name() { throw new Error("private-sentinel"); } }]) {
    const result = classifyImageError(error);
    assert.equal(result.code, "IMAGE_ENCRYPTION_FAILED");
    assert.equal(JSON.stringify(result).includes("private-sentinel"), false);
  }
  for (const code of ["private-sentinel", "constructor", "__proto__", null, { get toString() { throw new Error("private-sentinel"); } }]) {
    assert.equal(imageWorkerError(code).code, "IMAGE_ENCRYPTION_FAILED");
  }
});
