# HOST_DATA vectors

A guest's HOST_DATA is the SHA-256 of its init-data document, which the Pod
carries in the `io.katacontainers.config.hypervisor.cc_init_data` annotation
as base64 of gzip. Every reader of that annotation (this module's
`initDataSha256`, and a lifecycle controller's host-side reader) must agree on
which values are init-data and on the document each one holds; otherwise the
hash checked on one side is not the hash bound on the other.

The rule the vectors pin:

- the value is canonical base64: padded, standard alphabet, no whitespace,
  zero padding bits, so that re-encoding the decoded bytes gives the value back;
- the bytes are exactly one gzip member, with nothing after it;
- the document is at most `limit` bytes (1 MiB).

| File | Content |
| --- | --- |
| `host-data-vectors.json` | `limit`; `accept`: `{name, ccInitData, hostData}`, values every reader accepts, with their HOST_DATA; `refuse`: `{name, ccInitData}`, values every reader refuses |
| `MANIFEST.sha256` | the SHA-256 of the file above |

The vectors are shared byte for byte with the controller's tests.
`confidential-guests-host-data.test.ts` pins the manifest's own SHA-256. To
change a vector, change it in every copy in reviewed changes, with the pin,
and check that the publication guard scans it clean.
