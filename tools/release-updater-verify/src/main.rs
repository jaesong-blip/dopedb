//! Verifies a completed release updater closure using the same Minisign
//! `verify(data, signature, true)` semantics as `tauri-plugin-updater`.

use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use sha2::{Digest, Sha256};

const REPOSITORY: &str = "json-choi/dopedb";
const PLATFORMS: [(&str, &str, &[u8]); 3] = [
    ("darwin-aarch64", "aarch64.app.tar.gz", &[0x1f, 0x8b]),
    ("darwin-x86_64", "x64.app.tar.gz", &[0x1f, 0x8b]),
    ("windows-x86_64", "x64-setup.exe", b"MZ"),
];

struct Arguments {
    assets: PathBuf,
    downloads: PathBuf,
    manifest: PathBuf,
    root: PathBuf,
    tag: String,
}

struct Asset {
    digest: Option<String>,
    name: String,
    size: u64,
    url: String,
}

fn fail<T>(message: impl Into<String>) -> Result<T, String> {
    Err(message.into())
}

fn arg(values: &HashMap<String, String>, name: &str) -> Result<String, String> {
    values
        .get(name)
        .cloned()
        .ok_or_else(|| format!("missing {name}"))
}

fn arguments() -> Result<Arguments, String> {
    let mut values = HashMap::new();
    let mut input = std::env::args().skip(1);
    while let Some(name) = input.next() {
        if !name.starts_with("--") {
            return fail(format!("unexpected argument {name}"));
        }
        let value = input
            .next()
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| format!("missing value for {name}"))?;
        if values.insert(name.clone(), value).is_some() {
            return fail(format!("duplicate argument {name}"));
        }
    }
    let allowed = [
        "--assets",
        "--downloads",
        "--manifest",
        "--repository",
        "--root",
        "--tag",
    ];
    if values.keys().any(|name| !allowed.contains(&name.as_str())) {
        return fail("unknown verifier argument");
    }
    if arg(&values, "--repository")? != REPOSITORY {
        return fail("stable updater repository does not match the checked-in public endpoint");
    }
    Ok(Arguments {
        assets: arg(&values, "--assets")?.into(),
        downloads: arg(&values, "--downloads")?.into(),
        manifest: arg(&values, "--manifest")?.into(),
        root: arg(&values, "--root")?.into(),
        tag: arg(&values, "--tag")?,
    })
}

fn json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?)
        .map_err(|error| format!("{}: invalid JSON: {error}", path.display()))
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing non-empty string {field}"))
}

fn cargo_version(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|error| error.to_string())?
        .lines()
        .find_map(|line| {
            line.strip_prefix("version = \"")
                .and_then(|line| line.strip_suffix('"'))
        })
        .map(str::to_owned)
        .ok_or_else(|| format!("{} has no package version", path.display()))
}

fn lock_version(path: &Path) -> Result<String, String> {
    let lock = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut lines = lock.lines();
    while let Some(line) = lines.next() {
        if line == "name = \"dopedb\"" {
            return lines
                .next()
                .and_then(|line| {
                    line.strip_prefix("version = \"")
                        .and_then(|line| line.strip_suffix('"'))
                })
                .map(str::to_owned)
                .ok_or_else(|| "dopedb package has no lockfile version".to_owned());
        }
    }
    fail("Cargo.lock has no dopedb package")
}

fn version(arguments: &Arguments, manifest: &Value) -> Result<String, String> {
    let version = text(manifest, "version")?.to_owned();
    if arguments.tag != format!("app-v{version}") {
        return fail("manifest version does not match stable release tag");
    }
    let package = json(&arguments.root.join("package.json"))?;
    let tauri = json(&arguments.root.join("src-tauri/tauri.conf.json"))?;
    let versions = [
        text(&package, "version")?.to_owned(),
        text(&tauri, "version")?.to_owned(),
        cargo_version(&arguments.root.join("src-tauri/Cargo.toml"))?,
        lock_version(&arguments.root.join("Cargo.lock"))?,
    ];
    if versions.iter().any(|candidate| candidate != &version) {
        return fail("manifest version does not match every checked-in version source");
    }
    Ok(version)
}

fn public_key(root: &Path) -> Result<PublicKey, String> {
    let tauri = json(&root.join("src-tauri/tauri.conf.json"))?;
    let encoded = text(&tauri["plugins"]["updater"], "pubkey")?;
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    PublicKey::decode(&String::from_utf8(decoded).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn canonical_url(tag: &str, name: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}")
}

fn strict_digest(digest: &str) -> bool {
    digest.len() == 71
        && digest.starts_with("sha256:")
        && digest[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(bytes: &[u8]) -> String {
    let mut encoded = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn is_allowed_non_updater(name: &str, version: &str) -> bool {
    matches!(
        name,
        "latest.json"
            | "DopeDB-windows-x64-setup.exe"
            | "DopeDB-macos-arm64.dmg"
            | "DopeDB-macos-x64.dmg"
    ) || name == format!("DopeDB_{version}_aarch64.dmg")
        || name == format!("DopeDB_{version}_x64.dmg")
}

fn looks_like_updater(name: &str) -> bool {
    name.starts_with("DopeDB_")
        && (name.ends_with(".app.tar.gz")
            || name.ends_with(".app.tar.gz.sig")
            || name.ends_with("-setup.exe")
            || name.ends_with("-setup.exe.sig"))
}

fn assets(path: &Path, version: &str, tag: &str) -> Result<HashMap<String, Asset>, String> {
    let document = json(path)?;
    let values = document
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "assets JSON must contain an assets array".to_owned())?;
    let expected = PLATFORMS
        .iter()
        .flat_map(|(_, suffix, _)| {
            let name = format!("DopeDB_{version}_{suffix}");
            [name.clone(), format!("{name}.sig")]
        })
        .collect::<BTreeSet<_>>();
    let mut urls = HashMap::new();
    let mut names = BTreeSet::new();
    for value in values {
        let asset = Asset {
            digest: value
                .get("digest")
                .and_then(Value::as_str)
                .map(str::to_owned),
            name: text(value, "name")?.to_owned(),
            size: value
                .get("size")
                .and_then(Value::as_u64)
                .filter(|size| *size > 0)
                .ok_or_else(|| "asset size must be a positive unsigned integer".to_owned())?,
            url: text(value, "url")?.to_owned(),
        };
        if !names.insert(asset.name.clone()) || urls.contains_key(&asset.url) {
            return fail("duplicate release asset name or public URL");
        }
        if looks_like_updater(&asset.name) && !expected.contains(&asset.name) {
            return fail("release contains a stale or unsupported updater asset");
        }
        if !expected.contains(&asset.name) && !is_allowed_non_updater(&asset.name, version) {
            return fail("release contains an asset outside the stable allowlist");
        }
        if (expected.contains(&asset.name) || asset.name == "latest.json")
            && !asset.digest.as_deref().is_some_and(strict_digest)
        {
            return fail("exact updater assets and latest.json require a strict SHA-256 digest");
        }
        urls.insert(asset.url.clone(), asset);
    }
    for name in expected {
        let url = canonical_url(tag, &name);
        match urls.get(&url) {
            Some(asset) if asset.name == name => {}
            _ => return fail("release is missing an exact canonical updater closure asset"),
        }
    }
    Ok(urls)
}

fn verify_latest(arguments: &Arguments, assets: &HashMap<String, Asset>) -> Result<(), String> {
    let url = canonical_url(&arguments.tag, "latest.json");
    let asset = assets
        .get(&url)
        .ok_or("missing latest.json release asset")?;
    if asset.name != "latest.json" {
        return fail("latest.json URL does not name latest.json");
    }
    let bytes = fs::read(&arguments.manifest)
        .map_err(|error| format!("{}: {error}", arguments.manifest.display()))?;
    let actual_digest = digest(&bytes);
    if u64::try_from(bytes.len()).map_err(|_| "latest.json length overflow")? != asset.size
        || asset.digest.as_deref() != Some(actual_digest.as_str())
    {
        return fail("latest.json bytes do not match refreshed release metadata");
    }
    Ok(())
}

fn tauri_signature(entry: &Value, asset: &[u8]) -> Result<Signature, String> {
    let encoded = text(entry, "signature")?;
    if asset != encoded.as_bytes() {
        return fail("signature asset does not match manifest");
    }
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    if STANDARD.encode(&decoded) != encoded {
        return fail("signature must use canonical Base64");
    }
    let signature = String::from_utf8(decoded).map_err(|error| error.to_string())?;
    Signature::decode(&signature).map_err(|error| error.to_string())
}

fn verify(
    arguments: &Arguments,
    manifest: &Value,
    version: &str,
    assets: &HashMap<String, Asset>,
) -> Result<(), String> {
    let platforms = manifest
        .get("platforms")
        .and_then(Value::as_object)
        .ok_or_else(|| "manifest platforms must be an object".to_owned())?;
    let expected = PLATFORMS
        .iter()
        .map(|(name, _, _)| *name)
        .collect::<BTreeSet<_>>();
    if platforms
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != expected
    {
        return fail("manifest has unsupported, duplicate, or missing updater platform keys");
    }
    let key = public_key(&arguments.root)?;
    for (platform, suffix, header) in PLATFORMS {
        let entry = platforms.get(platform).ok_or("missing platform")?;
        let name = format!("DopeDB_{version}_{suffix}");
        let url = canonical_url(&arguments.tag, &name);
        if text(entry, "url")? != url {
            return fail(format!(
                "{platform} does not use the canonical public archive URL"
            ));
        }
        let archive_asset = assets.get(&url).ok_or("missing archive asset")?;
        let archive = arguments.downloads.join(&name);
        let bytes =
            fs::read(&archive).map_err(|error| format!("{}: {error}", archive.display()))?;
        let archive_digest = digest(&bytes);
        if u64::try_from(bytes.len()).map_err(|_| "archive length overflow")? != archive_asset.size
        {
            return fail(format!(
                "{platform} archive size does not match release metadata"
            ));
        }
        if archive_asset.digest.as_deref() != Some(archive_digest.as_str()) {
            return fail(format!(
                "{platform} archive SHA-256 does not match release metadata"
            ));
        }
        if !bytes.starts_with(header) {
            return fail(format!(
                "{platform} archive header does not match its platform format"
            ));
        }
        let signature_name = format!("{name}.sig");
        let signature_url = canonical_url(&arguments.tag, &signature_name);
        let signature_asset = assets
            .get(&signature_url)
            .ok_or("missing signature asset")?;
        let signature_path = arguments.downloads.join(&signature_name);
        let signature = fs::read(&signature_path)
            .map_err(|error| format!("{}: {error}", signature_path.display()))?;
        let signature_digest = digest(&signature);
        if u64::try_from(signature.len()).map_err(|_| "signature length overflow")?
            != signature_asset.size
        {
            return fail(format!(
                "{platform} signature size does not match release metadata"
            ));
        }
        let parsed =
            tauri_signature(entry, &signature).map_err(|error| format!("{platform}: {error}"))?;
        if signature_asset.digest.as_deref() != Some(signature_digest.as_str()) {
            return fail(format!(
                "{platform} signature SHA-256 does not match release metadata"
            ));
        }
        key.verify(&bytes, &parsed, true)
            .map_err(|error| format!("{platform}: {error}"))?;
        println!(
            "verified updater platform {platform}: {} bytes",
            bytes.len()
        );
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let arguments = arguments()?;
    let manifest = json(&arguments.manifest)?;
    let version = version(&arguments, &manifest)?;
    let assets = assets(&arguments.assets, &version, &arguments.tag)?;
    verify_latest(&arguments, &assets)?;
    verify(&arguments, &manifest, &version, &assets)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("release updater verification failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: minisign public test vector\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    #[test]
    fn tauri_compatible_minisign_rejects_bad_payload_and_key() {
        let key = PublicKey::decode(PUBLIC_KEY).unwrap();
        let signature = Signature::decode(SIGNATURE).unwrap();
        key.verify(b"test", &signature, true).unwrap();
        assert!(key.verify(b"Test", &signature, true).is_err());
        let wrong = PublicKey::decode(
            "untrusted comment: other\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO4",
        )
        .unwrap();
        assert!(wrong.verify(b"test", &signature, true).is_err());
    }

    #[test]
    fn tauri_manifest_signature_is_the_exact_sig_asset_text() {
        let encoded = STANDARD.encode(SIGNATURE);
        let entry = serde_json::json!({ "signature": encoded });
        tauri_signature(&entry, encoded.as_bytes()).unwrap();

        match tauri_signature(&entry, SIGNATURE.as_bytes()) {
            Err(error) => assert_eq!(error, "signature asset does not match manifest"),
            Ok(_) => panic!("raw Minisign text must not match the Tauri .sig asset"),
        }

        let malformed = format!("{encoded}\n");
        let malformed_entry = serde_json::json!({ "signature": malformed });
        assert!(tauri_signature(&malformed_entry, malformed.as_bytes()).is_err());
    }

    #[test]
    fn stale_or_unknown_updater_assets_are_detected() {
        assert!(looks_like_updater("DopeDB_0.1.0_x64-setup.exe.sig"));
        assert!(!is_allowed_non_updater(
            "DopeDB_0.1.0_x64-setup.exe",
            "0.2.0"
        ));
        assert!(is_allowed_non_updater("DopeDB-macos-x64.dmg", "0.2.0"));
    }

    #[test]
    fn digest_format_and_calculation_are_strict() {
        assert!(strict_digest(&digest(b"test")));
        assert!(!strict_digest("sha256:ABC"));
        assert!(!strict_digest(
            "sha512:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }
}
