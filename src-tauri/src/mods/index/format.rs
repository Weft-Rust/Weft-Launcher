//! The format of `index.json` and the rules every entry must follow, as described in
//! `docs/mod-manager/INDEX_FORMAT.md`. Nothing here checks a signature or touches the disk.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use super::super::abi::{is_abi, is_safe_ref};
use super::super::error::ModsError;

/// Reads a list one entry at a time and leaves out the entries that don't parse, so one bad
/// entry (an unknown channel, a missing field) never hides the rest.
fn lenient<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let raw = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| match serde_json::from_value(v) {
            Ok(t) => Some(t),
            Err(e) => {
                eprintln!("mod index: skipping an entry: {e}");
                None
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub schema: u32,
    pub generated: String,
    #[serde(default, deserialize_with = "lenient")]
    pub weft: Vec<WeftAbi>,
    #[serde(default, deserialize_with = "lenient")]
    pub mods: Vec<IndexMod>,
    #[serde(default, deserialize_with = "lenient")]
    pub revoked: Vec<Revoked>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct WeftAbi {
    pub tag: String,
    pub commit: String,
    pub abi: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexMod {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub versions: Vec<IndexVersion>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Release,
    Prerelease,
    Experimental,
}

impl Channel {
    /// How far from a release: a player on `release` never gets a prerelease.
    pub fn rank(self) -> u8 {
        match self {
            Channel::Release => 0,
            Channel::Prerelease => 1,
            Channel::Experimental => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
pub enum Platform {
    #[serde(rename = "windows-x64")]
    WindowsX64,
    #[serde(rename = "linux-x64")]
    LinuxX64,
    #[serde(rename = "macos-arm64")]
    MacosArm64,
}

impl Platform {
    pub const ALL: [Platform; 3] = [
        Platform::WindowsX64,
        Platform::LinuxX64,
        Platform::MacosArm64,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::WindowsX64 => "windows-x64",
            Platform::LinuxX64 => "linux-x64",
            Platform::MacosArm64 => "macos-arm64",
        }
    }

    /// `None` for a platform string this launcher doesn't know; such entries are ignored.
    pub fn parse(s: &str) -> Option<Platform> {
        Platform::ALL.into_iter().find(|p| p.as_str() == s)
    }

    /// The system this launcher runs on; `None` where the game isn't built.
    pub fn current() -> Option<Platform> {
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            Some(Platform::WindowsX64)
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some(Platform::LinuxX64)
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some(Platform::MacosArm64)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexVersion {
    pub version: String,
    pub channel: Channel,
    pub tag: String,
    #[serde(default)]
    pub published: String,
    pub source: SourceRef,
    pub weft: WeftRef,
    #[serde(default)]
    pub deps: Vec<Dep>,
    /// Kept as text: a platform this launcher doesn't know is ignored, not an error.
    #[serde(default)]
    pub platforms: Vec<String>,
    pub asset: Asset,
    #[serde(default)]
    pub provenance: Option<Provenance>,
    #[serde(default)]
    pub reviewed: Option<Reviewed>,
}

impl IndexVersion {
    /// The platforms this launcher knows, in the entry's order.
    pub fn known_platforms(&self) -> Vec<Platform> {
        let mut out: Vec<Platform> = Vec::new();
        for p in self.platforms.iter().filter_map(|p| Platform::parse(p)) {
            if !out.contains(&p) {
                out.push(p);
            }
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub repo: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeftRef {
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub commit: String,
    pub abi: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dep {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provenance {
    pub kind: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reviewed {
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revoked {
    pub sha256: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub at: String,
}

/// Ships inside every Weft; nothing may be installed under this id.
pub const RESERVED_ID: &str = "base";

pub fn is_mod_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

pub fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_repo(s: &str) -> bool {
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 100
            && p != "."
            && p != ".."
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    part(owner) && part(name)
}

/// GitHub treats `Owner/Repo` and `owner/repo` as one repo; so does the launcher.
pub fn same_repo(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Why `url` is not the release asset `<id>.zip` of `tag` in `repo`, if it isn't. It must be
/// `https://github.com/<owner>/<repo>/releases/download/<tag>/<id>.zip` exactly as written: no
/// other host, port, user, query or fragment, no `\`, no percent-encoding, no `.` or `..`.
pub fn asset_url_problem(id: &str, repo: &str, tag: &str, url: &str) -> Option<&'static str> {
    if url.contains('\\') {
        return Some("contains a backslash");
    }
    if url.contains('%') {
        return Some("percent-encoded");
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return Some("not a URL");
    };
    // The parser resolves `.` and `..` and fixes up odd spellings; a URL that changes when
    // parsed is not the one that was reviewed.
    if parsed.as_str() != url {
        return Some("not in canonical form");
    }
    if parsed.scheme() != "https" {
        return Some("not https");
    }
    if parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Some("not github.com");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Some("has a query or fragment");
    }
    let Some(segments) = parsed.path_segments() else {
        return Some("no path");
    };
    let segments: Vec<&str> = segments.collect();
    let Some((owner, name)) = repo.split_once('/') else {
        return Some("bad repo");
    };
    let zip = format!("{id}.zip");
    match segments.as_slice() {
        [o, r, "releases", "download", t, n]
            if o.eq_ignore_ascii_case(owner)
                && r.eq_ignore_ascii_case(name)
                && *t == tag
                && is_safe_ref(t)
                && *n == zip =>
        {
            None
        }
        _ => Some("not this repo's release asset"),
    }
}

/// A full git commit hash: 40 lowercase hex characters, or 64 in a SHA-256 repository.
pub fn is_commit(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `MAJOR.MINOR.PATCH`, then optionally `-prerelease` and `+build`: dot-separated parts of
/// `0-9 A-Z a-z -`, none empty.
pub fn is_semver(s: &str) -> bool {
    let (rest, build) = match s.split_once('+') {
        Some((r, b)) => (r, Some(b)),
        None => (s, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (rest, None),
    };
    let ident = |part: &str| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let dotted = |s: &str| s.split('.').all(ident);
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers
            .iter()
            .all(|n| !n.is_empty() && n.len() <= 18 && n.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(dotted)
        && build.is_none_or(dotted)
}

pub fn is_rfc3339(s: &str) -> bool {
    OffsetDateTime::parse(s, &Rfc3339).is_ok()
}

/// What the launcher shows of a summary; longer ones are cut, not refused.
pub const MAX_SUMMARY_CHARS: usize = 140;

pub fn clamp_summary(summary: &mut String) {
    let line = summary.lines().next().unwrap_or("").trim();
    *summary = if line.chars().count() > MAX_SUMMARY_CHARS {
        let cut: String = line.chars().take(MAX_SUMMARY_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        line.to_string()
    };
}

/// The contract's rules for one version of one mod. A version that breaks them is left out.
pub fn version_problem(id: &str, v: &IndexVersion) -> Option<String> {
    if !is_semver(&v.version) {
        return Some(format!("version {:?}", v.version));
    }
    if !is_repo(&v.source.repo) {
        return Some(format!("source repo {:?}", v.source.repo));
    }
    if !is_commit(&v.source.commit) {
        return Some(format!("source commit {:?}", v.source.commit));
    }
    if !v.weft.commit.is_empty() && !is_commit(&v.weft.commit) {
        return Some(format!("weft commit {:?}", v.weft.commit));
    }
    if !v.published.is_empty() && !is_rfc3339(&v.published) {
        return Some(format!("published {:?}", v.published));
    }
    if !is_safe_ref(&v.tag) {
        return Some(format!("tag {:?}", v.tag));
    }
    if v.asset.name != format!("{id}.zip") {
        return Some(format!("asset name {:?}", v.asset.name));
    }
    if let Some(why) = asset_url_problem(id, &v.source.repo, &v.tag, &v.asset.url) {
        return Some(format!("asset url {:?}: {why}", v.asset.url));
    }
    if !is_sha256(&v.asset.sha256) {
        return Some("sha256".into());
    }
    if !is_abi(&v.weft.abi) {
        return Some("abi".into());
    }
    if let Some(tag) = &v.weft.tag
        && !is_safe_ref(tag)
    {
        return Some(format!("weft tag {tag:?}"));
    }
    if v.deps.iter().any(|d| !is_mod_id(&d.id)) {
        return Some("deps".into());
    }
    None
}

/// Keeps what follows the contract and drops the rest, so one bad entry doesn't hide the others.
/// Every version in the index must say who reviewed it: that is what Reviewed means.
pub fn sanitize(mut index: Index) -> Index {
    index
        .mods
        .retain(|m| is_mod_id(&m.id) && m.id != RESERVED_ID);
    for m in &mut index.mods {
        let id = m.id.clone();
        m.versions.retain(|v| {
            let problem = version_problem(&id, v).or_else(|| match &v.reviewed {
                Some(r) if !r.by.trim().is_empty() => None,
                _ => Some("no review recorded".into()),
            });
            match problem {
                None => true,
                Some(problem) => {
                    eprintln!("mod index: dropping {id} {}: {problem}", v.version);
                    false
                }
            }
        });
        m.icon = m.icon.take().filter(|u| u.starts_with("https://"));
        m.homepage = m.homepage.take().filter(|u| u.starts_with("https://"));
        clamp_summary(&mut m.summary);
    }
    index.mods.retain(|m| !m.versions.is_empty());
    index.weft.retain(|w| is_safe_ref(&w.tag) && is_abi(&w.abi));
    index.revoked.retain(|r| is_sha256(&r.sha256));
    index
}

/// Reads index bytes whose signature already verified: `schema` 1 and an RFC 3339 `generated`,
/// or the whole index is refused; any other bad entry costs only that entry.
pub fn parse(bytes: &[u8]) -> Result<Index, ModsError> {
    let index: Index =
        serde_json::from_slice(bytes).map_err(|e| ModsError::IndexInvalid(e.to_string()))?;
    if index.schema != 1 {
        return Err(ModsError::IndexInvalid(format!("schema {}", index.schema)));
    }
    if generated_at(&index).is_none() {
        return Err(ModsError::IndexInvalid(format!(
            "generated {:?}",
            index.generated
        )));
    }
    Ok(sanitize(index))
}

pub fn generated_at(index: &Index) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(&index.generated, &Rfc3339).ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn version(id: &str, repo: &str, sha: &str) -> IndexVersion {
        IndexVersion {
            version: "0.2.0".into(),
            channel: Channel::Release,
            tag: format!("{id}-v0.2.0"),
            published: "2026-11-04T00:00:00Z".into(),
            source: SourceRef {
                repo: repo.into(),
                commit: "c".repeat(40),
            },
            weft: WeftRef {
                tag: Some("v26.11.1".into()),
                commit: "f".repeat(40),
                abi: "f470b1cbb1f9ad91".into(),
            },
            deps: vec![Dep { id: "base".into() }],
            platforms: vec!["linux-x64".into()],
            asset: Asset {
                name: format!("{id}.zip"),
                url: format!("https://github.com/{repo}/releases/download/{id}-v0.2.0/{id}.zip"),
                size: 10,
                sha256: sha.into(),
            },
            provenance: None,
            reviewed: Some(Reviewed {
                by: "Zorro909".into(),
                at: "2026-11-04".into(),
            }),
        }
    }

    #[test]
    fn contract_rules_drop_bad_versions() {
        let sha = "a".repeat(64);
        let ok = || version("cogwork", "Zorro909/weft-mods", &sha);
        assert!(version_problem("cogwork", &ok()).is_none());

        type Change = fn(&mut IndexVersion);
        let cases: &[(&str, Change)] = &[
            ("other host", |v| {
                v.asset.url = "https://evil.example/cogwork.zip".into()
            }),
            ("other repo", |v| {
                v.asset.url =
                    "https://github.com/Someone/else/releases/download/x/cogwork.zip".into()
            }),
            ("asset name", |v| v.asset.name = "other.zip".into()),
            ("sha256 shape", |v| v.asset.sha256 = "ABC".into()),
            ("repo shape", |v| v.source.repo = "../x".into()),
            ("tag shape", |v| v.tag = "../x".into()),
            ("url names another tag", |v| {
                v.asset.url =
                    "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v9/cogwork.zip"
                        .into()
            }),
            ("abi shape", |v| v.weft.abi = "F00".into()),
            ("dep id", |v| v.deps = vec![Dep { id: "A-B".into() }]),
            ("version not semver", |v| v.version = "0.2".into()),
            ("version with junk", |v| v.version = "0.2.0-rc..1".into()),
            ("short commit", |v| v.source.commit = "cceea78".into()),
            ("commit in capitals", |v| v.source.commit = "C".repeat(40)),
            ("short weft commit", |v| v.weft.commit = "ff9c712".into()),
            ("published not a date", |v| v.published = "yesterday".into()),
        ];
        for (what, change) in cases {
            let mut v = ok();
            change(&mut v);
            assert!(version_problem("cogwork", &v).is_some(), "{what}");
        }
    }

    /// The bypasses found in review: each one parsed into a URL in another repo, or a
    /// different file, while still starting with the right prefix.
    #[test]
    fn asset_url_bypasses_are_refused() {
        let repo = "Zorro909/weft-mods";
        let tag = "cogwork-v0.2.0";
        let good =
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip";
        assert_eq!(asset_url_problem("cogwork", repo, tag, good), None);
        // Owner and repo compare without case, like GitHub does.
        assert_eq!(
            asset_url_problem("cogwork", "zorro909/WEFT-mods", tag, good),
            None
        );

        let bad = [
            r"https://github.com/Zorro909/weft-mods/releases/download/..\..\..\..\evil\repo\releases\download\x\cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/repo/releases/download/x/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/%2E%2E/x/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/x/..",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/../cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/../../../evil/repo/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/./cogwork-v0.2.0/cogwork.zip",
            "http://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com:8443/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://user@github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com.evil.example/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://GITHUB.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip?x=1",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip#x",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/other.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/sub/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/latest/download/cogwork.zip",
            "https://github.com/Zorro909/weft-mods-evil/releases/download/cogwork-v0.2.0/cogwork.zip",
            "not a url",
        ];
        for url in bad {
            assert!(
                asset_url_problem("cogwork", repo, tag, url).is_some(),
                "{url}"
            );
        }
    }

    #[test]
    fn ids_and_repos() {
        assert!(is_mod_id("cogwork"));
        assert!(is_mod_id("my_mod2"));
        assert!(!is_mod_id("Cogwork"));
        assert!(!is_mod_id("a-b"));
        assert!(!is_mod_id(""));
        assert!(is_repo("Zorro909/weft-mods"));
        assert!(!is_repo("Zorro909"));
        assert!(!is_repo("a/b/c"));
        assert!(!is_repo("../b"));
        assert!(same_repo("Zorro909/Weft-Mods", "zorro909/weft-mods"));
    }

    fn mod_json(id: &str, versions: &str) -> String {
        format!(r#"{{ "id": "{id}", "name": "{id}", "versions": [{versions}] }}"#)
    }

    fn version_json(id: &str, channel: &str, sha_char: char) -> String {
        let v = version(id, "Zorro909/weft-mods", &sha_char.to_string().repeat(64));
        let mut value = serde_json::to_value(&v).unwrap();
        value["channel"] = serde_json::Value::String(channel.into());
        value.to_string()
    }

    /// One broken entry, anywhere, costs only that entry.
    #[test]
    fn a_bad_entry_does_not_reject_the_index() {
        let good = version_json("cogwork", "release", 'a');
        let unknown_channel = version_json("cogwork", "nightly", 'b');
        let unreviewed = {
            let mut v: serde_json::Value =
                serde_json::from_str(&version_json("cogwork", "release", 'c')).unwrap();
            v["reviewed"] = serde_json::Value::Null;
            v.to_string()
        };
        let odd_platform = {
            let mut v: serde_json::Value =
                serde_json::from_str(&version_json("showcase", "release", 'd')).unwrap();
            v["platforms"] = serde_json::json!(["linux-x64", "plan9-mips"]);
            v.to_string()
        };
        let mods = [
            mod_json("cogwork", &[good, unknown_channel, unreviewed].join(",")),
            mod_json("showcase", &odd_platform),
            r#"{ "id": "noname", "versions": [] }"#.to_string(),
            mod_json("base", &version_json("base", "release", 'e')),
            r#""not even an object""#.to_string(),
        ];
        let json = format!(
            r#"{{ "schema": 1, "generated": "2026-11-04T00:00:00Z",
                 "weft": [ {{ "tag": "v26.11.1", "commit": "x", "abi": "f470b1cbb1f9ad91" }}, {{ "tag": 5 }} ],
                 "mods": [{}],
                 "revoked": [ {{ "sha256": "{}" }}, {{ "reason": "no hash" }} ] }}"#,
            mods.join(","),
            "f".repeat(64)
        );
        let index = parse(json.as_bytes()).unwrap();
        let ids: Vec<&str> = index.mods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["cogwork", "showcase"]);
        assert_eq!(index.mods[0].versions.len(), 1, "only the good cogwork");
        assert_eq!(index.mods[0].versions[0].asset.sha256, "a".repeat(64));
        assert_eq!(
            index.mods[1].versions[0].known_platforms(),
            [Platform::LinuxX64]
        );
        assert_eq!(index.weft.len(), 1);
        assert_eq!(index.revoked.len(), 1);
    }

    #[test]
    fn an_index_needs_schema_1_and_a_date() {
        assert!(parse(br#"{ "schema": 2, "generated": "2026-11-04T00:00:00Z" }"#).is_err());
        assert!(parse(br#"{ "schema": 1, "generated": "yesterday" }"#).is_err());
        assert!(parse(br#"{ "schema": 1, "generated": "2026-11-04T00:00:00Z" }"#).is_ok());
    }

    #[test]
    fn versions_commits_and_summaries() {
        for good in [
            "0.2.0",
            "0.2.1-rc.1",
            "0.1.2-experimental.4563878.917596d",
            "1.0.0+build.5",
        ] {
            assert!(is_semver(good), "{good}");
        }
        for bad in [
            "",
            "0.2",
            "v0.2.0",
            "0.2.0.1",
            "0.2.0-",
            "0.2.0-rc..1",
            "a.b.c",
            "0.2.0 ",
        ] {
            assert!(!is_semver(bad), "{bad:?}");
        }
        assert!(is_commit(&"a".repeat(40)) && is_commit(&"a".repeat(64)));
        assert!(!is_commit(&"a".repeat(41)) && !is_commit("cceea78"));

        // An optional weft commit may be left out; an empty `published` too.
        let mut v = version("cogwork", "Zorro909/weft-mods", &"a".repeat(64));
        v.weft.commit = String::new();
        v.published = String::new();
        assert!(version_problem("cogwork", &v).is_none());

        let mut long = "x".repeat(MAX_SUMMARY_CHARS + 10);
        clamp_summary(&mut long);
        assert_eq!(long.chars().count(), MAX_SUMMARY_CHARS);
        assert!(long.ends_with('…'));
        let mut two_lines = "First line.\nSecond line.".to_string();
        clamp_summary(&mut two_lines);
        assert_eq!(two_lines, "First line.");
    }
}
