use super::*;
use x509_parser::prelude::{FromDer, X509Certificate};

/// Componentwise security version floor from the authenticated release.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tcb {
    pub bootloader: u8,
    pub tee: u8,
    pub snp: u8,
    pub microcode: u8,
}
impl Tcb {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            self.bootloader > 0 && self.snp > 0 && self.microcode > 0,
            "nonzero SNP security floor required"
        );
        Ok(())
    }
    fn includes(&self, value: &[u8]) -> bool {
        value.len() == 8
            && value[2..6] == [0; 4]
            && value[0] >= self.bootloader
            && value[1] >= self.tee
            && value[6] >= self.snp
            && value[7] >= self.microcode
    }
}

// The v2/v3/v5 Milan report layouts are specified by AMD publication 56860,
// through revision 1.58, section 7.3. V5 adds signed mitigation vectors at
// 0x1f8/0x200; it preserves the TCB, report-data and signature offsets. Newer
// or unknown versions require a separate review, never a permissive fallback.
// Decode offsets from bounded bytes so verification is portable to arm64
// management/owner clients; sev's device library requires x86 RDRAND.
pub(super) fn verify(
    raw: &[u8],
    vlek: &[u8],
    asvk: &[u8],
    expected: &[u8; 64],
    floor: &Tcb,
    now: u64,
    root: &X509,
) -> Result<()> {
    floor.validate()?;
    ensure!(
        raw.len() == 1184
            && !vlek.is_empty()
            && vlek.len() <= MAX_CERTIFICATE
            && !asvk.is_empty()
            && asvk.len() <= MAX_CERTIFICATE,
        "invalid SNP evidence size"
    );
    let word =
        |offset| u32::from_le_bytes(raw[offset..offset + 4].try_into().expect("bounded report"));
    let version = word(0);
    ensure!(
        matches!(version, 2 | 3 | 5),
        "unsupported SNP report version"
    );
    let policy = u64::from_le_bytes(raw[8..16].try_into()?);
    let platform = u64::from_le_bytes(raw[64..72].try_into()?);
    let key_info = word(72);
    let policy_bits = if version == 5 { 26 } else { 25 };
    let platform_mask = match version {
        2 => 0x1f,
        3 => 0x3f,
        5 => 0xbf,
        _ => unreachable!("version checked above"),
    };
    let cpuid_reserved = if version == 2 { 392 } else { 395 };
    let tail_reserved = if version == 5 { 520 } else { 504 };
    ensure!(
        policy >> policy_bits == 0
            && policy & (1 << 17) != 0
            && platform & !platform_mask == 0
            && raw[76..80].iter().all(|byte| *byte == 0)
            && raw[cpuid_reserved..416].iter().all(|byte| *byte == 0)
            && raw[491] == 0
            && raw[495] == 0
            && raw[tail_reserved..672].iter().all(|byte| *byte == 0)
            && raw[816..1184].iter().all(|byte| *byte == 0),
        "invalid SNP reserved fields"
    );
    ensure!(
        word(48) == 0
            && word(52) == 1
            && (key_info >> 2) & 7 == 1
            && key_info & !31 == 0
            && key_info & 2 == 0
            && policy & ((1 << 19) | (1 << 18)) == 0
            && raw[80..144] == *expected
            && raw[144..192] != [0; 48],
        "unapproved SNP guest state"
    );
    // VLEK is the shared-tenancy signing key. CHIP_ID may legitimately be
    // masked; MASK_CHIP_KEY instead suppresses signing and is forbidden above.
    // Identity/locality here comes from the measured Nitro collector.
    ensure!(
        version == 2 || (raw[392] == 0x19 && raw[393] <= 0x0f),
        "unapproved SNP processor"
    );
    let reported = &raw[384..392];
    for offset in [56, 384, 480, 496] {
        ensure!(
            floor.includes(&raw[offset..offset + 8]),
            "SNP firmware below release security floor"
        );
    }
    let leaf = X509::from_der(vlek)?;
    verify_chain(&leaf, &[X509::from_der(asvk)?], root, now)?;
    let key = leaf.public_key()?.ec_key()?;
    ensure!(
        key.group().curve_name() == Some(Nid::SECP384R1),
        "P384 VLEK required"
    );
    let (remaining, parsed) =
        X509Certificate::from_der(vlek).map_err(|_| anyhow::anyhow!("invalid VLEK"))?;
    ensure!(remaining.is_empty(), "trailing VLEK bytes");
    let extensions = parsed
        .extensions_map()
        .map_err(|_| anyhow::anyhow!("duplicate VLEK extension"))?;
    for (oid, value) in [
        ("1.3.6.1.4.1.3704.1.3.1", reported[0]),
        ("1.3.6.1.4.1.3704.1.3.2", reported[1]),
        ("1.3.6.1.4.1.3704.1.3.3", reported[6]),
        ("1.3.6.1.4.1.3704.1.3.8", reported[7]),
    ] {
        let field = extensions
            .iter()
            .find_map(|(id, ext)| (id.to_id_string() == oid).then_some(ext.value))
            .context("missing VLEK security version")?;
        let expected = if value < 128 {
            vec![2, 1, value]
        } else {
            vec![2, 2, 0, value]
        };
        ensure!(
            field == expected,
            "VLEK security version does not match report"
        );
    }
    // ECDSA components in the SNP ABI are 72-byte little endian integers;
    // valid P384 values have zero high padding. Verify original signed bytes.
    ensure!(
        raw[720..744] == [0; 24] && raw[792..816] == [0; 24],
        "invalid SNP signature padding"
    );
    let r: Vec<_> = raw[672..720].iter().rev().copied().collect();
    let s: Vec<_> = raw[744..792].iter().rev().copied().collect();
    let signature =
        EcdsaSig::from_private_components(BigNum::from_slice(&r)?, BigNum::from_slice(&s)?)?;
    ensure!(
        signature.verify(&Sha384::digest(&raw[..672]), &key)?,
        "invalid SNP report signature"
    );
    Ok(())
}
