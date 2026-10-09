"""Wire types shared by the Job and host agent.

Field names match the existing JSON receipts and Crossplane request. Runtime
validation remains necessary because SSH and Kubernetes are serialization boundaries.
"""

from typing import Any, TypedDict

# External command output and Kubernetes envelopes have independently versioned schemas.
JsonObject = dict[str, Any]


class Artifact(TypedDict):
    url: str
    sha256: str


class DiskRequirements(TypedDict):
    minSizeGiB: int


class DiskPolicy(DiskRequirements, total=False):
    serial: str


class ValueRange(TypedDict):
    min: int
    max: int


class ParameterLayout(TypedDict):
    name: str
    offset: int
    width: int
    value: int


class UefiParameter(ParameterLayout, total=False):
    allowedValues: list[int]
    range: ValueRange


class UefiVariable(TypedDict):
    name: str
    guid: str
    payloadSize: int
    attributes: int
    parameters: list[UefiParameter]


class ModuleParameter(TypedDict):
    module: str
    parameter: str
    value: str


class FirmwareChecks(TypedDict, total=False):
    cpuFlags: list[str]
    moduleParameters: list[ModuleParameter]


class FirmwareLayout(TypedDict):
    match: dict[str, str]
    variables: list[UefiVariable]


class FirmwareProfile(FirmwareLayout, total=False):
    rebootTimeoutSeconds: int
    verification: FirmwareChecks


class Mirror(TypedDict):
    hostname: str
    directory: str


class InstallationRequirements(TypedDict):
    kernel: Artifact
    initrd: Artifact
    disk: DiskPolicy
    rootSizeGiB: int
    volumeGroup: str
    suite: str
    mirror: Mirror


class Installation(InstallationRequirements, total=False):
    timeoutSeconds: int
    dualStack: bool
    dnsServers: list[str]
    uefi: FirmwareProfile


class SshIdentity(TypedDict):
    user: str
    port: int
    secretName: str
    workerSecretName: str


class SshSettings(SshIdentity, total=False):
    knownHostsSecretName: str
    trustOnFirstUse: bool


class WorkerSpec(TypedDict):
    address: str
    hostname: str
    ssh: SshSettings
    installation: Installation


class Receipt(TypedDict):
    uid: str
    fingerprint: str
    hostname: str
    sourceBootId: str


class VariableBackup(TypedDict):
    name: str
    before: str
    after: str
    flags: int


class FirmwareCheckpoint(TypedDict):
    uid: str
    fingerprint: str
    bootId: str
    variables: list[VariableBackup]
    complete: bool
    changed: bool


class FirmwareTransaction(FirmwareCheckpoint, total=False):
    rebootRequested: bool
