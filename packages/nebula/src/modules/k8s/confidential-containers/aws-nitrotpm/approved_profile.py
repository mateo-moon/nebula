"""Produce a review candidate from build-time AWS PCR compute output."""
import argparse
import hashlib
import json
from pathlib import Path
from verifier import require, validate_profiles


def candidate(workload, profile, policy, measurements, resources):
    values = measurements["Measurements"]
    require(values["HashAlgorithm"] == "SHA384", "SHA384 measurements required")
    require("PCR4" in values and "PCR12" in values, "patched PCR compute output required")
    pcrs = {"4": values["PCR4"].lower(), "12": values["PCR12"].lower()}
    result = {workload: {"profile": profile, "policy_sha256": hashlib.sha256(policy).hexdigest(),
                       "pcrs": pcrs, "resources": resources, "reviewed": True}}
    validate_profiles(result)
    result[workload]["reviewed"] = False
    return result


def main():
    parser = argparse.ArgumentParser()
    for name in ["workload", "profile", "policy", "measurements", "output"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--resource", action="append", required=True)
    args = parser.parse_args()
    profile = candidate(args.workload, args.profile, Path(args.policy).read_bytes(),
                        json.loads(Path(args.measurements).read_text()), args.resource)
    with Path(args.output).open("x") as output:
        output.write(json.dumps(profile, indent=2) + "\n")


if __name__ == "__main__":
    main()
