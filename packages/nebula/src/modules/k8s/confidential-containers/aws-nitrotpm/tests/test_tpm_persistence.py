"""Software-TPM experiments, never the host's TPM and never an install step.

These tests exercise real tpm2-tools against a fresh libtpms emulator. They do
not qualify NitroTPM's persistence, locality, NV limits or AWS lifecycle.
"""
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("NEBULA_SWTPM_TEST") != "1", reason="isolated software TPM job only")
PARENT = "0x81010010"
INDEX = "0x01810010"
PCRS = "sha384:4,12"


class Emulator:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.state = self.directory / "hardware"
        self.state.mkdir()
        self.process = None
        # Reserve both ports together while selecting an adjacent pair. The
        # emulator binds only loopback; no device/default TCTI is ever selected.
        for _ in range(100):
            with socket.socket() as server, socket.socket() as control:
                server.bind(("127.0.0.1", 0))
                self.port = server.getsockname()[1]
                if self.port == 65535:
                    continue
                try:
                    control.bind(("127.0.0.1", self.port + 1))
                    break
                except OSError:
                    continue
        else:
            raise RuntimeError("cannot reserve emulator ports")
        self.env = {"PATH": os.environ["PATH"], "TMPDIR": str(self.directory),
                    "TPM2TOOLS_TCTI": f"swtpm:host=127.0.0.1,port={self.port}"}

    def run(self, tool, *args, ok=True, error=None):
        assert tool.startswith("tpm2_")
        result = subprocess.run([tool, *map(str, args)], cwd=self.directory, env=self.env,
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
        # Argument/TCTI errors must never masquerade as authorization rejection.
        accepted = result.returncode == 0 if ok else result.returncode in (1, 3)
        assert accepted, f"{tool}: unexpected status {result.returncode}: {result.stderr.decode(errors='replace')}"
        if not ok:
            # Match the full TPM response code, including its parameter/session
            # index. A resource exhaustion or transport error is not this proof.
            codes = {int(value, 16) for value in re.findall(rb"\(0x([0-9a-fA-F]+)\)", result.stderr)}
            assert error is not None and error in codes, f"{tool}: expected TPM error {error!r}: {result.stderr.decode(errors='replace')}"
        return result

    def start(self):
        log = self.directory / "swtpm.log"
        with log.open("ab") as errors:
            self.process = subprocess.Popen([
                "swtpm", "socket", "--tpm2", "--tpmstate", f"dir={self.state}",
                "--server", f"type=tcp,bindaddr=127.0.0.1,port={self.port}",
                "--ctrl", f"type=tcp,bindaddr=127.0.0.1,port={self.port + 1}",
                "--flags", "not-need-init"], stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=errors)
        for _ in range(100):
            assert self.process.poll() is None, f"software TPM exited: {log.read_text(errors='replace')}"
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("software TPM did not start")
        self.run("tpm2_startup", "-c")

    def stop(self, abrupt=False):
        if self.process is not None:
            if abrupt:
                self.process.kill()
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None

    def restart(self, abrupt=False):
        if not abrupt:
            self.run("tpm2_shutdown", "-c")
        self.stop(abrupt=abrupt)
        self.start()

    def policy(self, name, algorithm, command, trial=False):
        context = f"{name}.ctx"
        self.run("tpm2_startauthsession", *( [] if trial else ["--policy-session"]),
                 "-g", algorithm, "-S", context)
        self.run("tpm2_policypcr", "-S", context, "-l", PCRS)
        self.run("tpm2_policycommandcode", "-S", context, "-L", f"{name}.policy", command)
        return context

    def initialize(self):
        # Fake secrets are generated inside the disposable /dev/shm fixture.
        # The production appliance must never expose this material to an operator.
        self.root = secrets.token_bytes(32)
        self.owner = secrets.token_bytes(32)
        (self.directory / "owner.auth").write_bytes(self.owner)
        (self.directory / "sealing.input").write_bytes(self.root + self.owner)
        self.run("tpm2_createprimary", "-C", "o", "-G", "ecc", "-g", "sha256", "-c", "parent.ctx")
        self.run("tpm2_evictcontrol", "-C", "o", "-c", "parent.ctx", PARENT)
        self.run("tpm2_flushcontext", "-t")
        context = self.policy("seal", "sha256", "TPM2_CC_Unseal", trial=True)
        self.run("tpm2_flushcontext", context)
        self.run("tpm2_create", "-C", PARENT, "-g", "sha256",
                 "-i", "sealing.input", "-u", "sealed.pub", "-r", "sealed.priv",
                 "-L", "seal.policy", "-a", "fixedtpm|fixedparent|adminwithpolicy|noda")
        (self.directory / "sealing.input").unlink()
        self.run("tpm2_changeauth", "-c", "o", "file:owner.auth")
        context = self.policy("nv", "sha384", "TPM2_CC_NV_Extend", trial=True)
        self.run("tpm2_flushcontext", context)
        self.run("tpm2_nvdefine", INDEX, "-C", "o", "-P", "file:owner.auth", "-s", "48",
                 "-g", "sha384", "-a", "nt=extend|policywrite|authread|no_da", "-L", "nv.policy")
        self.run("tpm2_load", "-C", PARENT, "-u", "sealed.pub", "-r", "sealed.priv", "-c", "sealed.ctx")
        # Empty-password unseal must fail, even on the right boot state.
        self.run("tpm2_unseal", "-c", "sealed.ctx", "-o", "forbidden.output", ok=False, error=0x12F)
        self.run("tpm2_flushcontext", "-t")

    def unseal(self, ok=True):
        self.run("tpm2_load", "-C", PARENT, "-u", "sealed.pub", "-r", "sealed.priv", "-c", "sealed.ctx")
        context = self.policy("unseal", "sha256", "TPM2_CC_Unseal")
        output = self.directory / "unsealed.output"
        output.unlink(missing_ok=True)
        try:
            self.run("tpm2_unseal", "-c", "sealed.ctx", "-p", f"session:{context}", "-o", output, ok=ok, error=0x99D)
            if ok:
                assert output.read_bytes() == self.root + self.owner
            else:
                assert not output.exists() or output.stat().st_size == 0
        finally:
            output.unlink(missing_ok=True)
            self.run("tpm2_flushcontext", context)
            self.run("tpm2_flushcontext", "-t")

    def extend(self, value, ok=True):
        (self.directory / "event").write_bytes(value)
        context = self.policy("extend", "sha384", "TPM2_CC_NV_Extend")
        try:
            self.run("tpm2_nvextend", INDEX, "-C", INDEX, "-P", f"session:{context}", "-i", "event", ok=ok, error=0x99D)
        finally:
            self.run("tpm2_flushcontext", context)

    def anchor(self):
        self.run("tpm2_nvread", INDEX, "-C", INDEX, "-s", "48", "-o", "anchor.output")
        value = (self.directory / "anchor.output").read_bytes()
        assert len(value) == 48
        return value


@pytest.fixture
def emulator():
    # Explicit opt-in with missing tooling is a failure, not a silent skip.
    assert shutil.which("swtpm") and shutil.which("tpm2_startup")
    assert Path("/dev/shm").is_dir()
    with tempfile.TemporaryDirectory(prefix="nebula-tpm-test-", dir="/dev/shm") as directory:
        instance = Emulator(directory)
        try:
            instance.start()
            instance.initialize()
            yield instance
        finally:
            instance.stop()


@pytest.mark.parametrize("abrupt", [False, True], ids=["graceful", "abrupt"])
def test_seal_and_exact_nv_history_survive_preserved_tpm_restart(emulator, abrupt):
    first = hashlib.sha384(b"first encrypted record").digest()
    second = hashlib.sha384(b"second encrypted record").digest()
    emulator.extend(first)
    initial = hashlib.sha384(bytes(48) + first).digest()
    assert emulator.anchor() == initial
    emulator.unseal()
    emulator.restart(abrupt=abrupt)
    emulator.unseal()
    assert emulator.anchor() == initial
    emulator.extend(second)
    assert emulator.anchor() == hashlib.sha384(initial + second).digest()


@pytest.mark.parametrize("pcr", [4, 12])
def test_changed_boot_cannot_unseal_write_delete_or_redefine_history(emulator, pcr):
    emulator.extend(hashlib.sha384(b"committed state").digest())
    initial = emulator.anchor()
    emulator.run("tpm2_pcrextend", f"{pcr}:sha384={'01' * 48}")
    emulator.unseal(ok=False)
    emulator.extend(hashlib.sha384(b"forged state").digest(), ok=False)
    emulator.run("tpm2_nvundefine", INDEX, "-C", "o", ok=False, error=0x9A2)
    emulator.run("tpm2_nvdefine", INDEX, "-C", "o", "-s", "48", ok=False, error=0x9A2)
    emulator.run("tpm2_nvextend", INDEX, "-C", INDEX, "-i", "event", ok=False, error=0x12F)
    emulator.run("tpm2_nvextend", INDEX, "-C", "o", "-P", "file:owner.auth", "-i", "event", ok=False, error=0x149)
    assert emulator.anchor() == initial


def test_clearing_tpm_destroys_the_old_seal_instead_of_rolling_it_back(emulator):
    emulator.extend(hashlib.sha384(b"committed state").digest())
    emulator.run("tpm2_clear", "-c", "l")
    emulator.run("tpm2_createprimary", "-C", "o", "-G", "ecc", "-g", "sha256", "-c", "new-parent.ctx")
    emulator.run("tpm2_load", "-C", "new-parent.ctx", "-u", "sealed.pub", "-r", "sealed.priv", "-c", "forbidden.ctx", ok=False, error=0x1DF)


def test_copying_the_sealed_disk_blobs_to_another_tpm_cannot_load_the_key(emulator):
    with tempfile.TemporaryDirectory(prefix="nebula-tpm-clone-test-", dir="/dev/shm") as directory:
        other = Emulator(directory)
        try:
            other.start()
            other.initialize()
            for part in ["pub", "priv"]:
                shutil.copyfile(emulator.directory / f"sealed.{part}", other.directory / f"copied.{part}")
            other.run("tpm2_load", "-C", PARENT, "-u", "copied.pub", "-r", "copied.priv", "-c", "forbidden.ctx", ok=False, error=0x1DF)
        finally:
            other.stop()


def test_workload_pcr_extends_exact_sha384_bytes_and_cannot_be_reset(emulator):
    descriptor = hashlib.sha384(b"exact signed descriptor bytes").digest()
    emulator.run("tpm2_pcrread", "sha384:15", "-o", "pcr15")
    assert (emulator.directory / "pcr15").read_bytes() == bytes(48)
    emulator.run("tpm2_pcrextend", f"15:sha384={descriptor.hex()}")
    emulator.run("tpm2_pcrread", "sha384:15", "-o", "pcr15")
    expected = hashlib.sha384(bytes(48) + descriptor).digest()
    assert (emulator.directory / "pcr15").read_bytes() == expected
    emulator.run("tpm2_pcrreset", "15", ok=False, error=0x907)
    emulator.run("tpm2_pcrread", "sha384:15", "-o", "pcr15")
    assert (emulator.directory / "pcr15").read_bytes() == expected


def test_unwritten_nv_index_is_distinct_from_an_empty_committed_history(emulator):
    # A production anchor adapter must authenticate the index public definition
    # and distinguish its unwritten flag; it must not turn arbitrary read errors
    # (missing index, wrong policy, failed transport) into an empty journal.
    emulator.run("tpm2_nvread", INDEX, "-C", INDEX, "-s", "48", "-o", "unwritten.output",
                 ok=False, error=0x14A)
    event = hashlib.sha384(b"first committed record").digest()
    emulator.extend(event)
    assert emulator.anchor() == hashlib.sha384(bytes(48) + event).digest()
