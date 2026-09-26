import { Construct } from "constructs";
import { KubeConfigMap } from "cdk8s-plus-33/lib/imports/k8s";
import { sha256Hex } from "./canonical";
import { dnsLabel, dnsSubdomain, fail, integer, list, record, syncWave, unique, waveAnnotations } from "./validate";

const OWNER = "SignedReleases";

/**
 * A DSSE envelope as the signer wrote it. It is rendered with
 * `JSON.stringify` exactly as given (field order included); only
 * `payloadType` and `payload` are read.
 */
export interface DsseEnvelope {
  readonly payloadType: string;
  /** Base64 of the signed statement, a JSON object. */
  readonly payload: string;
  readonly signatures?: readonly unknown[];
  readonly [field: string]: unknown;
}

/** The DSSE payload types of one wire format. */
export interface ReleasePayloadTypes {
  /** Payload type of the release statement. */
  readonly release: string;
  /** Payload type of the release-set statement. */
  readonly releaseSet: string;
}

/** An authority's envelopes in one wire format. */
export interface SignedReleaseEnvelopes {
  readonly release: DsseEnvelope;
  /** Present exactly when {@link SignedReleasesProps.releaseSet} is true. */
  readonly releaseSet?: DsseEnvelope;
}

/** One ConfigMap: an authority's envelopes in one wire format. */
export interface SignedReleaseFormat {
  /** A key of {@link SignedReleasesProps.payloadTypes}. */
  readonly format: string;
  /** The ConfigMap a guest trusting this authority in this format mounts. */
  readonly configMap: string;
  readonly envelopes: SignedReleaseEnvelopes;
}

/**
 * `active` signs freely. `retiring` signs only payload bytes that an active
 * authority also signs in the same render, or payloads its `pinned` list
 * names. `retired` is refused: its envelopes must leave the render.
 */
export type SignedReleaseAuthorityStatus = "active" | "retiring" | "retired";

export interface SignedReleaseAuthority {
  /** The authority's identifier, lowercase hex (for example a key fingerprint). */
  readonly fingerprint: string;
  readonly status: SignedReleaseAuthorityStatus;
  /** Every `expires_at` this authority signs must be at most this (Unix seconds). */
  readonly cap?: number;
  /**
   * SHA-256 (lowercase hex) of each payload a retiring authority may carry
   * without an active authority signing the same bytes in the same format.
   */
  readonly pinned?: readonly string[];
  /**
   * The ConfigMaps this authority renders, one per wire format, in render
   * order; the first is the default of {@link SignedReleases.configMapOf}.
   * Two formats are "dual envelopes": the same releases for readers that
   * accept different payload types.
   */
  readonly formats: readonly SignedReleaseFormat[];
}

export interface SignedReleasesProps {
  readonly namespace: string;
  /**
   * The wire formats, by name: the DSSE payload types every envelope of that
   * format must carry. Required, with no default: a payload type is part of
   * what is signed, so each deployment names the ones its guests accept
   * (the neutral names are in `NEUTRAL_WIRE.payloadTypes`). No value may
   * appear twice across formats.
   */
  readonly payloadTypes: Readonly<Record<string, ReleasePayloadTypes>>;
  /** The authorities whose envelopes render, in render order. */
  readonly authorities: readonly SignedReleaseAuthority[];
  /**
   * The authorities trusted by the guests that read now. Within a format
   * they must all carry the same payload bytes.
   */
  readonly reading: readonly string[];
  /** Whether the release-set envelope is delivered (a reader reads it). */
  readonly releaseSet: boolean;
  /** In-guest file names. Default `release.dsse.json` and `release-set.dsse.json`. */
  readonly fileNames?: { readonly release: string; readonly releaseSet: string };
  /** Argo sync wave. Default `-2`. */
  readonly wave?: string;
}

interface Decoded { readonly envelope: DsseEnvelope; readonly payload: Record<string, unknown>; readonly bytes: Buffer }
interface Rendered {
  readonly authority: SignedReleaseAuthority;
  readonly format: SignedReleaseFormat;
  readonly documents: readonly Decoded[];
  /** Comparable payload bytes of this ConfigMap. */
  readonly bytes: string;
}

const FINGERPRINT = /^[0-9a-f]{8,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function decode(envelope: unknown, expected: string, where: string): Decoded {
  const value = envelope as DsseEnvelope;
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(OWNER, `${where} must be a DSSE envelope`);
  if (value.payloadType !== expected) fail(OWNER, `${where} payloadType must be ${JSON.stringify(expected)}, got ${JSON.stringify(value.payloadType)}`);
  if (typeof value.payload !== "string") fail(OWNER, `${where} payload must be a base64 string`);
  const bytes = Buffer.from(value.payload, "base64");
  let payload: unknown;
  try {
    if (bytes.toString("base64") !== value.payload) throw new Error("not canonical");
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(OWNER, `${where} payload is not base64 JSON`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail(OWNER, `${where} payload is not a JSON object`);
  return { envelope: value, payload: payload as Record<string, unknown>, bytes };
}

/**
 * Signed release statements for confidential guests, one ConfigMap per
 * authority and wire format. A guest mounts the ConfigMap of the authority
 * it trusts and verifies the envelopes itself; this construct refuses a
 * render that would give guests inconsistent statements:
 * - the guests that read now see one payload per format, whatever authority
 *   they trust;
 * - across authorities one release-set `sequence` names one payload, and a
 *   set only non-reading guests see is never ahead of the one readers read;
 * - a retiring authority signs only bytes an active one signs (or payloads
 *   its entry pins); a retired one never renders;
 * - every `expires_at` an authority signs stays within its `cap`.
 * Payload types are required props: there is no default wire name.
 */
export class SignedReleases extends Construct {
  /** Every rendered ConfigMap name, in render order. */
  public readonly configMaps: readonly string[];
  private readonly byAuthority: ReadonlyMap<string, readonly SignedReleaseFormat[]>;

  constructor(scope: Construct, id: string, props: SignedReleasesProps) {
    super(scope, id);
    const namespace = dnsLabel(OWNER, "namespace", props.namespace);
    const wave = syncWave(OWNER, "wave", props.wave ?? "-2");
    const files = props.fileNames ?? { release: "release.dsse.json", releaseSet: "release-set.dsse.json" };
    for (const name of [files.release, files.releaseSet]) {
      if (typeof name !== "string" || name.length > 253 || !FILE_NAME.test(name)) fail(OWNER, `file name ${JSON.stringify(name)} is not a ConfigMap key`);
    }
    if (files.release === files.releaseSet) fail(OWNER, "the release and release-set file names must differ");
    if (typeof props.releaseSet !== "boolean") fail(OWNER, "releaseSet must be a boolean");

    const formats = record<ReleasePayloadTypes>(OWNER, "payloadTypes", props.payloadTypes);
    if (Object.keys(formats).length === 0) fail(OWNER, "payloadTypes must name at least one wire format");
    const owners = new Map<string, string>();
    for (const [format, types] of Object.entries(formats)) {
      for (const kind of ["release", "releaseSet"] as const) {
        const value = types?.[kind];
        if (typeof value !== "string" || !MEDIA_TYPE.test(value)) fail(OWNER, `payloadTypes.${format}.${kind} must be a media type`);
        const other = owners.get(value);
        if (other !== undefined) fail(OWNER, `payloadType ${JSON.stringify(value)} is used twice (${other} and ${format}.${kind})`);
        owners.set(value, `${format}.${kind}`);
      }
    }

    const authorities = list<SignedReleaseAuthority>(OWNER, "authorities", props.authorities, 1);
    unique(OWNER, "authority", authorities.map(a => a?.fingerprint));
    const rendered: Rendered[] = [];
    for (const authority of authorities) {
      const fp = authority.fingerprint;
      if (typeof fp !== "string" || !FINGERPRINT.test(fp)) fail(OWNER, `authority fingerprint must be lowercase hex, got ${JSON.stringify(fp)}`);
      if (!["active", "retiring", "retired"].includes(authority.status)) fail(OWNER, `authority ${fp} status must be active, retiring or retired`);
      if (authority.status === "retired") fail(OWNER, `authority ${fp} is retired; its envelopes must leave the render`);
      if (authority.cap !== undefined) integer(OWNER, `authority ${fp} cap`, authority.cap, 0);
      for (const pin of authority.pinned ?? []) {
        if (typeof pin !== "string" || !SHA256.test(pin)) fail(OWNER, `authority ${fp} pinned entries must be lowercase hex sha256`);
      }
      const own = list<SignedReleaseFormat>(OWNER, `authority ${fp} formats`, authority.formats, 1);
      unique(OWNER, `authority ${fp} format`, own.map(f => f?.format));
      for (const format of own) {
        const types = Object.hasOwn(formats, format.format) ? formats[format.format] : fail(OWNER, `authority ${fp} names an unknown format ${JSON.stringify(format.format)}`);
        dnsSubdomain(OWNER, `authority ${fp} configMap`, format.configMap);
        const where = `authority ${fp} (${format.format})`;
        const envelopes = format.envelopes;
        if (envelopes === null || typeof envelopes !== "object") fail(OWNER, `${where} envelopes must be an object`);
        if (props.releaseSet !== (envelopes.releaseSet !== undefined)) {
          fail(OWNER, `${where}: the release set is delivered exactly when releaseSet is true`);
        }
        const documents = [decode(envelopes.release, types.release, `${where} release`),
          ...(props.releaseSet ? [decode(envelopes.releaseSet, types.releaseSet, `${where} releaseSet`)] : [])];
        rendered.push({ authority, format, documents, bytes: JSON.stringify(documents.map(d => d.envelope.payload)) });
      }
    }
    unique(OWNER, "configMap", rendered.map(r => r.format.configMap));

    const fingerprints = new Set(authorities.map(a => a.fingerprint));
    const reading = list<string>(OWNER, "reading", props.reading, 1);
    unique(OWNER, "reading authority", reading);
    for (const fp of reading) if (!fingerprints.has(fp)) fail(OWNER, `reading authority ${JSON.stringify(fp)} is not rendered`);
    const readers = new Set(reading);

    // Reviewed bounds first: a cap on every signed expiry, pins for a retiring authority signing alone.
    for (const one of rendered) {
      const { authority } = one;
      if (authority.cap !== undefined && !one.documents.every(d => Number.isSafeInteger(d.payload.expires_at) && (d.payload.expires_at as number) <= authority.cap!)) {
        fail(OWNER, `authority ${authority.fingerprint} signs past its reviewed cap`);
      }
      const cosigned = rendered.some(other => other.format.format === one.format.format && other.authority.status === "active" && other.bytes === one.bytes);
      if (authority.status === "retiring" && !cosigned
        && !one.documents.every(d => (authority.pinned ?? []).includes(sha256Hex(d.bytes)))) {
        fail(OWNER, `retiring authority ${authority.fingerprint} signs alone only payloads its entry pins`);
      }
    }

    // Consistency within each wire format: payload bytes are only comparable there.
    for (const format of Object.keys(formats)) {
      const members = rendered.filter(r => r.format.format === format);
      const readingMembers = members.filter(r => readers.has(r.authority.fingerprint));
      const first = readingMembers[0];
      if (first && !readingMembers.every(r => r.bytes === first.bytes)) {
        fail(OWNER, `the reading guests' authorities must sign the same payload bytes (format ${format})`);
      }
      if (props.releaseSet && members.length > 1) {
        const sequence = new Map(members.map(r => {
          const value = r.documents[1].payload.sequence;
          if (!Number.isSafeInteger(value) || (value as number) < 0) fail(OWNER, `release set of ${r.authority.fingerprint} (${format}) has no sequence`);
          return [r, value as number] as const;
        }));
        for (const one of members) {
          for (const other of members) {
            if (sequence.get(one) === sequence.get(other) && one.bytes !== other.bytes) {
              fail(OWNER, `authorities ${one.authority.fingerprint} and ${other.authority.fingerprint} sign sequence ${sequence.get(one)} over different payload bytes (format ${format})`);
            }
          }
        }
        if (first) {
          const frozen = members.filter(r => !readers.has(r.authority.fingerprint) && sequence.get(r)! > sequence.get(first)!);
          if (frozen.length) fail(OWNER, `frozen authority ${frozen.map(r => r.authority.fingerprint).join(", ")} is ahead of the set the reading guests read (format ${format})`);
        }
      }
      for (const one of readingMembers.filter(r => r.authority.status === "retiring")) {
        if (!members.every(other => other.authority.status !== "active" || other.bytes === one.bytes)) {
          fail(OWNER, `retiring authority ${one.authority.fingerprint} signs only the payload bytes every active authority signs (format ${format})`);
        }
      }
    }

    for (const { format } of rendered) {
      new KubeConfigMap(this, format.configMap, {
        metadata: { name: format.configMap, namespace, annotations: waveAnnotations(wave) },
        data: {
          [files.release]: JSON.stringify(format.envelopes.release),
          ...(props.releaseSet ? { [files.releaseSet]: JSON.stringify(format.envelopes.releaseSet) } : {}),
        },
      });
    }
    this.configMaps = rendered.map(r => r.format.configMap);
    this.byAuthority = new Map(authorities.map(a => [a.fingerprint, a.formats]));
  }

  /**
   * The ConfigMap a guest trusting `fingerprint` mounts, in `format` (default:
   * the authority's first format).
   * @throws Error when the authority or format is not rendered.
   */
  public configMapOf(fingerprint: string, format?: string): string {
    const formats = this.byAuthority.get(fingerprint) ?? fail(OWNER, `authority ${JSON.stringify(fingerprint)} is not rendered`);
    const match = format === undefined ? formats[0] : formats.find(f => f.format === format);
    return match?.configMap ?? fail(OWNER, `authority ${fingerprint} renders no format ${JSON.stringify(format)}`);
  }
}
