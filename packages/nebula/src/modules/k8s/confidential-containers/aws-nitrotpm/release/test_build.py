"""Offline release-contract regressions; no observed hardware PCRs are inputs."""
import unittest
import json
from pathlib import Path
import tempfile

from build import CAA_REVISION, sha, uki_measurements
from complete import verify_worker_receipts
from webhook import PATCH as WEBHOOK_PATCH


class UkiMeasurementsTests(unittest.TestCase):
    def test_standard_uki_pins_reset_parameter_register(self):
        # NitroTPM-Tools computes PCR12 from a fresh, unextended register.
        result = uki_measurements({"HashAlgorithm": "SHA384", "PCR4": "AB" * 48, "PCR12": "00" * 48})
        self.assertEqual(result, {"pcr4": "ab" * 48, "pcr12": "0" * 96})

    def test_missing_boot_identity_or_malformed_measurements_are_refused(self):
        valid = {"HashAlgorithm": "SHA384", "PCR4": "ab" * 48, "PCR12": "0" * 96}
        for change in ({"PCR4": "0" * 96}, {"PCR12": None}, {"PCR12": "0" * 64},
                       {"PCR4": "g" * 96}, {"HashAlgorithm": "SHA256"}, {"HashAlgorithm": "SHA384-extra"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                uki_measurements({**valid, **change})


class WorkerReceiptTests(unittest.TestCase):
    def test_candidate_refuses_stale_or_malformed_worker_builds(self):
        source = Path(__file__).resolve().parents[1]
        webhook = {"version": 1, "sourceRevision": CAA_REVISION,
            "patchSha256": sha(source / "release/patches" / WEBHOOK_PATCH), "binarySha256": "ab" * 32, "licenseSha256": "cd" * 32}
        helper = {"version": 1, "sourceSha256": sha(source / "release/mount-helper/main.go"), "binarySha256": "ef" * 32}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            def receipts(w=webhook, h=helper):
                (directory / "webhook-build.json").write_text(json.dumps(w))
                (directory / "mount-helper-build.json").write_text(json.dumps(h))
            receipts()
            verify_worker_receipts(directory, source)
            for change in ({"sourceRevision": "stale"}, {"patchSha256": "ab" * 32}, {"binarySha256": "missing"}, {"licenseSha256": None}):
                receipts({**webhook, **change})
                with self.subTest(change=change), self.assertRaises(ValueError):
                    verify_worker_receipts(directory, source)
            for change in ({"sourceSha256": "ab" * 32}, {"binarySha256": None}, {"unexpected": True}):
                receipts(h={**helper, **change})
                with self.subTest(change=change), self.assertRaises(ValueError):
                    verify_worker_receipts(directory, source)


if __name__ == "__main__":
    unittest.main()
