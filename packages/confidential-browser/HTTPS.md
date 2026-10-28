# Workload-hosted HTTPS proof of concept

The optional HTTPS front end serves the first HTML, JavaScript and TNG WASM
from a measured SEV-SNP VM. Users need an ordinary browser and one HTTPS link.
The browser authenticates that first page through its normal certificate trust
store; the loader then verifies the preparation VM before loading its UI over
TNG. No user-side installation is needed.

## Trust and enrollment

The DNS custodian must be independent of every administrator being excluded.
It controls a dedicated hostname, certificate issuance policy and an enrollment
signing key. Only its public key is included in the measured deployment.
Management-owned DNS, administrator-held wildcard certificates or TLS termination
at an ordinary ingress would not provide this boundary.

1. DevOps deploys `ConfidentialBrowser` with `https.authorityPublicKeyPem`, pinned
   images and native genpolicy. Forward ports 80 and 443 directly to the guest;
   expose the separate TNG attested enrollment port. No private TLS key, ACME key,
   DNS credential or enrollment signing key belongs in Kubernetes.
2. The VM generates its TLS and ACME account keys in guest tmpfs. The custodian
   prepares its verifier from independently reviewed SNP/native-policy
   measurements, then uses `confidential-client https-enroll --state STATE
   --tng TNG` to read the public identity through the attested channel.
3. The custodian points its fresh hostname to the service and restricts issuance
   to the returned ACME account. Following [Let's Encrypt's CAA guidance](https://letsencrypt.org/docs/caa/), publish CAA `issue` with
   `letsencrypt.org; accounturi=ACCOUNT_URI; validationmethods=http-01`, prohibit
   wildcard issuance with `issuewild ";"`, and remove other allowed issuers.
   The hostname must have no pre-existing administrator-held certificate or
   covering wildcard. DNS, delegation and registrar custody remain external
   trust roots; CAA does not protect against their owners changing the records.
4. The custodian authorizes that exact VM instance, public key, ACME account,
   hostname and preparation/stack origins:

   ```sh
   confidential-client https-enroll --state STATE --tng /absolute/path/to/tng \
     --authority-key /private/custodian.key --hostname confidential.example.org \
     --preparation https://preparation.example.org --stack https://stack.example.org
   ```

5. The guest completes HTTP-01 itself and installs the certificate for its
   guest-held key. Port 80 serves only active ACME challenges. HTTPS stays closed
   until a matching certificate is available. Renewal uses the same guest-held
   ACME account; restarting the VM requires fresh custodian enrollment.

Cluster and host administrators can redirect traffic or deny service, but a
redirected server does not possess the TLS private key. Another approved VM
generates a different key and ACME account and cannot reuse this enrollment.
The custodian's native CLI is an administrator tool, separate from the browser
flow used by workload owners.

## Qualification boundary

The implementation uses the standard ACME HTTP-01 and CAA account-binding
pattern, adapted to CoCo/TNG. It does not deploy the dstack gateway or KMS.
The PoC is a separate diskless HTTPS VM so existing enrolled workloads and their
storage are preserved. Its loader carries reviewed preparation measurements;
the endpoint cannot supply its own trust policy.

Unit tests exercise real TLS, signature and instance binding, certificate/key
substitution, hostname verification and rejected key-export paths. A private
test CA can qualify guest TLS without changing any system trust store, but it
does not prove public-CA CAA enforcement or an installation-free browser flow.
Those require a hostname and DNS authority outside the excluded administrators.
