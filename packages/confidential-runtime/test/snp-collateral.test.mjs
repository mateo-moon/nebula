import assert from "node:assert/strict";
import { test } from "node:test";
import { snpKdsUrl } from "../dist/snp-collateral.js";

test("native CoCo sev 7 evidence selects named CPUID and TCB fields", () => {
  const report = { version: 3, key_info: 0, cpuid_fam_id: 0x19, cpuid_mod_id: 1, chip_id: Array(64).fill(1),
    reported_tcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88, fmc: null } };
  const milan = new URL(snpKdsUrl(report));
  assert.match(milan.pathname, /^\/vcek\/v1\/Milan\//);
  assert.equal(milan.searchParams.get("snpSPL"), "24");
  const turin = new URL(snpKdsUrl({ ...report, version: 5, cpuid_fam_id: 0x1a, cpuid_mod_id: 0x11,
    reported_tcb: { bootloader: 3, tee: 2, snp: 5, microcode: 97, fmc: 1 } }));
  assert.match(turin.pathname, /^\/vcek\/v1\/Turin\/0101010101010101$/);
  assert.equal(turin.searchParams.get("fmcSPL"), "01");
  assert.equal(turin.searchParams.get("blSPL"), "03");
  assert.equal(turin.searchParams.get("snpSPL"), "05");
  assert.throws(() => snpKdsUrl({ ...report, cpuid_fam_id: 0xff }));
});
