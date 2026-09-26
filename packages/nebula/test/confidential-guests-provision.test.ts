import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { defaultProvisionTemplate, provisionScript, readConfidentialGuestAsset, type ProvisionTemplate } from "../src/modules/k8s/confidential-guests";

const GiB = 1024 ** 3;
const target = { stateDir: "/var/lib/guests", file: "data-v3.img", loop: 203, sizeBytes: 64 * GiB, sizeLabel: "64Gi" };

// The fields a reader (and a test of the rendering application) extracts from
// a provisioning script: backing file, device, mknod tuple, stat tuple, size
// and the capacity it reports.
const fields = (script: string) => {
  const field = (pattern: RegExp) => script.match(pattern)?.[1];
  return [field(/^dir=(\S+)$/m), field(/^file=\$dir\/(\S+)$/m), field(/^device=(\S+)$/m), field(/mknod "\$device" (b 7 \d+);/),
    field(/= '(7:[0-9a-f]+)' \]/), field(/^size=(\d+)$/m), field(/retained (\S+) block volume ready/)];
};

test("the default template is a runnable script for its own reference disk", () => {
  const template = defaultProvisionTemplate();
  assert.equal(template.script, readConfidentialGuestAsset("provision.sh"));
  const { stateDir, file, loop, sizeBytes, sizeLabel } = template.reference;
  assert.deepEqual(fields(template.script), [stateDir, file, `/dev/loop${loop}`, `b 7 ${loop}`, `7:${loop.toString(16)}`, String(sizeBytes), sizeLabel]);
  // Retargeting to the reference changes nothing.
  assert.equal(provisionScript({ ...template.reference }), template.script);
});

test("provisionScript retargets every disk-specific value and keeps every safety check", () => {
  const script = provisionScript(target);
  assert.deepEqual(fields(script), ["/var/lib/guests", "data-v3.img", "/dev/loop203", "b 7 203", "7:cb", String(64 * GiB), "64Gi"]);
  const { reference } = defaultProvisionTemplate();
  for (const token of [reference.stateDir, reference.file, `/dev/loop${reference.loop}`, `b 7 ${reference.loop}`, `'7:${reference.loop.toString(16)}'`,
    String(reference.sizeBytes), reference.sizeLabel]) {
    assert.ok(!script.includes(token), `reference value ${token} survived`);
  }
  assert.ok(script.startsWith("set -eu\n"));
  for (const check of [
    "exec 9>\"$dir/provision.lock\"\nflock -x 9\n",
    "[ ! -L \"$file\" ] || { echo 'refusing backing-file symlink'; exit 1; }\n",
    "(set -C; : > \"$file\")\n  fallocate -l \"$size\" \"$file\"\n",
    "[ \"$(stat -c %h \"$file\")\" = 1 ]",
    "[ -b \"$device\" ] && [ ! -L \"$device\" ]",
    "[ \"$associated\" = \"$device\" ] || { echo 'loop slot occupied; refusing'; exit 1; }\n",
    "[ -z \"$associated\" ] || { echo 'backing file attached elsewhere; refusing'; exit 1; }\n",
    "losetup \"$device\" \"$file\"\n",
    "chown 0:6 \"$device\"\nchmod 0660 \"$device\"\n",
    "while :; do sleep 60; done\n",
  ]) assert.ok(script.includes(check), check);
});

test("any template written for another reference disk renders the same script", () => {
  const base = defaultProvisionTemplate();
  const other = { stateDir: "/srv/other-reference", file: "ref-v9.img", loop: 250, sizeBytes: 16 * 1024 ** 2, sizeLabel: "16Mi" };
  const rewritten: ProvisionTemplate = { reference: other, script: provisionScript({ ...other }) };
  assert.notEqual(rewritten.script, base.script);
  assert.equal(provisionScript({ ...target, template: rewritten }), provisionScript(target));
  assert.equal(provisionScript({ ...target, template: base }), provisionScript(target));
});

test("replacement is one pass: a target value never becomes a later reference value", () => {
  const { reference } = defaultProvisionTemplate();
  // A state directory that contains the reference size label must survive the size label replacement.
  const stateDir = `/var/lib/x${reference.sizeLabel}`;
  const script = provisionScript({ ...target, stateDir, sizeBytes: 16 * 1024 ** 2, sizeLabel: "16Mi" });
  assert.equal(fields(script)[0], stateDir);
  assert.equal(fields(script)[6], "16Mi");
});

test("a stage placeholder writes only its magic first sector and refuses a changed one", () => {
  const magic = "EXAMPLE-STAGE-PLACEHOLDER-V1\n";
  const script = provisionScript({ ...target, sizeBytes: 16 * 1024 ** 2, sizeLabel: "16Mi", placeholderMagic: magic });
  const sector = Buffer.concat([Buffer.from(magic, "ascii"), Buffer.alloc(512 - magic.length)]);
  const sha = createHash("sha256").update(sector).digest("hex");
  assert.ok(script.includes("(set -C; printf 'EXAMPLE-STAGE-PLACEHOLDER-V1\\n' > \"$file\")\n  fallocate -l \"$size\" \"$file\"\n"));
  assert.ok(script.includes("  echo 'refusing changed backing file'; exit 1;\n}\n"
    + `[ "$(head -c 512 "$file" | sha256sum | cut -d' ' -f1)" = '${sha}' ] || {\n`
    + "  echo 'refusing changed stage placeholder'; exit 1;\n}\n"));
  assert.ok(!script.includes(": > \"$file\""));
  // Everything else is the ordinary script.
  const plain = provisionScript({ ...target, sizeBytes: 16 * 1024 ** 2, sizeLabel: "16Mi" });
  assert.equal(script.split("\n").length, plain.split("\n").length + 3);
  // A magic without a line break is written as is.
  const bare = provisionScript({ ...target, placeholderMagic: "GUEST-PLACEHOLDER" });
  assert.ok(bare.includes("printf 'GUEST-PLACEHOLDER' > \"$file\""));
  const bareSector = Buffer.concat([Buffer.from("GUEST-PLACEHOLDER"), Buffer.alloc(512 - 17)]);
  assert.ok(bare.includes(createHash("sha256").update(bareSector).digest("hex")));
});

test("a placeholder magic is printable ASCII that printf and the shell take literally, one sector at most", () => {
  for (const magic of ["", "\n", "it's", "100%", "back\\slash", "two\nlines\n", "space here", "é", "$(id)", "`id`", "x".repeat(513), "x".repeat(512) + "\n"]) {
    assert.throws(() => provisionScript({ ...target, placeholderMagic: magic }), /placeholder magic/, JSON.stringify(magic));
  }
  assert.doesNotThrow(() => provisionScript({ ...target, placeholderMagic: "x".repeat(511) + "\n" }));
  assert.doesNotThrow(() => provisionScript({ ...target, placeholderMagic: "x".repeat(512) }));
});

test("a template must contain every reference value, and the placeholder anchors once", () => {
  const base = defaultProvisionTemplate();
  const missing: ProvisionTemplate = { reference: base.reference, script: base.script.replace(/^size=.*\n/m, "size=1\n") };
  assert.throws(() => provisionScript({ ...target, template: missing }), /reference value/);
  const overlapping: ProvisionTemplate = { reference: { ...base.reference, file: "data-v1.img", stateDir: "/var/lib/data-v1.img" }, script: base.script };
  assert.throws(() => provisionScript({ ...target, template: overlapping }), /reference value/);
  const noAnchor: ProvisionTemplate = { reference: base.reference, script: base.script.replace("(set -C; : > \"$file\")", "touch \"$file\"") };
  assert.doesNotThrow(() => provisionScript({ ...target, template: noAnchor }));
  assert.throws(() => provisionScript({ ...target, template: noAnchor, placeholderMagic: "M\n" }), /placeholder/);
  const twice: ProvisionTemplate = { reference: base.reference, script: base.script + "  echo 'refusing changed backing file'; exit 1;\n}\n" };
  assert.throws(() => provisionScript({ ...target, template: twice, placeholderMagic: "M\n" }), /placeholder/);
});

test("disk values are validated before they reach a privileged script", () => {
  const refusals: [string, object, RegExp][] = [
    ["relative state dir", { stateDir: "var/lib/guests" }, /stateDir/],
    ["parent segment", { stateDir: "/var/lib/../etc" }, /stateDir/],
    ["trailing slash", { stateDir: "/var/lib/guests/" }, /stateDir/],
    ["root", { stateDir: "/" }, /stateDir/],
    ["shell characters", { stateDir: "/var/lib/g;rm" }, /stateDir/],
    ["file with a slash", { file: "a/b.img" }, /file/],
    ["hidden file", { file: ".data.img" }, /file/],
    ["negative minor", { loop: -1 }, /loop/],
    ["minor 2^20", { loop: 2 ** 20 }, /loop/],
    ["size not in sectors", { sizeBytes: GiB + 1, sizeLabel: "1073741825" }, /sizeBytes/],
    ["zero size", { sizeBytes: 0, sizeLabel: "0" }, /sizeBytes/],
    ["label and size disagree", { sizeBytes: 2 * GiB, sizeLabel: "1Gi" }, /sizeLabel/],
    ["decimal suffix", { sizeBytes: 10 ** 9, sizeLabel: "1G" }, /sizeLabel/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => provisionScript({ ...target, ...change } as any), error, label);
  assert.doesNotThrow(() => provisionScript({ ...target, sizeBytes: 4096, sizeLabel: "4096" }));
  assert.doesNotThrow(() => provisionScript({ ...target, sizeBytes: 4 * 1024, sizeLabel: "4Ki" }));
});
