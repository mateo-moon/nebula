"""Offline release-contract regressions; no observed hardware PCRs are inputs."""
import unittest

from build import uki_measurements


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


if __name__ == "__main__":
    unittest.main()
