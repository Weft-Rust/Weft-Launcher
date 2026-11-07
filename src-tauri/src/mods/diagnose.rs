//! Names the mod that stopped the game from starting. Weft exits with code 1 and leaves the
//! reason in its log; these are the engine's own messages (`crates/engine/src/modloader.rs`),
//! which `crates/app/src/main.rs` logs with `log::error!`, so as `<time> ERROR [weft] <message>`
//! (`crates/engine/src/log.rs`). Only ERROR lines of the target `weft` count: the engine logs
//! ordinary mod loading at INFO, and a mod's own lines (`[mod:x]`) may say anything.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// `mod X was built against another mod ABI (…)`
    WrongVersion,
    /// `loading mod X from <path>: <why>`
    LoadFailed,
    /// `<path> is not a Weft mod`
    NotAMod,
    /// `mod X is the crate Y: name its folder or zip Y`
    WrongName,
    /// `mod X requires missing mod Y`
    MissingDep,
    /// `X: init panicked`, after the mod's own `[mod:X] panicked at …`
    InitPanicked,
}

/// The first mod failure in a run's log, by kind, each with what that kind names. `modId` is the
/// mod the engine blamed, when the line names one; `line` is the log line, so the player can
/// search for it.
#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModFailure {
    WrongVersion {
        #[serde(rename = "modId")]
        mod_id: Option<String>,
        line: String,
    },
    LoadFailed {
        #[serde(rename = "modId")]
        mod_id: Option<String>,
        line: String,
    },
    NotAMod {
        #[serde(rename = "modId")]
        mod_id: Option<String>,
        line: String,
    },
    WrongName {
        #[serde(rename = "modId")]
        mod_id: Option<String>,
        /// The crate the library is: the name its folder or zip needs.
        #[serde(rename = "crate")]
        crate_name: String,
        line: String,
    },
    MissingDep {
        #[serde(rename = "modId")]
        mod_id: Option<String>,
        /// The mod that is missing.
        dependency: String,
        line: String,
    },
    InitPanicked {
        #[serde(rename = "modId")]
        mod_id: Option<String>,
        line: String,
    },
}

impl ModFailure {
    pub fn kind(&self) -> FailureKind {
        match self {
            Self::WrongVersion { .. } => FailureKind::WrongVersion,
            Self::LoadFailed { .. } => FailureKind::LoadFailed,
            Self::NotAMod { .. } => FailureKind::NotAMod,
            Self::WrongName { .. } => FailureKind::WrongName,
            Self::MissingDep { .. } => FailureKind::MissingDep,
            Self::InitPanicked { .. } => FailureKind::InitPanicked,
        }
    }

    fn mod_id_mut(&mut self) -> &mut Option<String> {
        match self {
            Self::WrongVersion { mod_id, .. }
            | Self::LoadFailed { mod_id, .. }
            | Self::NotAMod { mod_id, .. }
            | Self::WrongName { mod_id, .. }
            | Self::MissingDep { mod_id, .. }
            | Self::InitPanicked { mod_id, .. } => mod_id,
        }
    }

    pub fn mod_id(&self) -> Option<&str> {
        match self {
            Self::WrongVersion { mod_id, .. }
            | Self::LoadFailed { mod_id, .. }
            | Self::NotAMod { mod_id, .. }
            | Self::WrongName { mod_id, .. }
            | Self::MissingDep { mod_id, .. }
            | Self::InitPanicked { mod_id, .. } => mod_id.as_deref(),
        }
    }

    pub fn line(&self) -> &str {
        match self {
            Self::WrongVersion { line, .. }
            | Self::LoadFailed { line, .. }
            | Self::NotAMod { line, .. }
            | Self::WrongName { line, .. }
            | Self::MissingDep { line, .. }
            | Self::InitPanicked { line, .. } => line,
        }
    }
}

fn word_after<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = &line[line.find(prefix)? + prefix.len()..];
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

/// `…/mods/libcogwork.so` or `C:\…\123-cogwork.dll` → `cogwork`.
fn id_from_library(path: &str) -> Option<String> {
    let file = path.rsplit(['/', '\\']).next()?;
    let stem = file
        .strip_suffix(".dll")
        .or_else(|| file.strip_suffix(".so"))
        .or_else(|| file.strip_suffix(".dylib"))?;
    // The engine loads a copy named `<pid>-<file>`.
    let stem = stem.split_once('-').map_or(stem, |(pid, rest)| {
        if pid.bytes().all(|b| b.is_ascii_digit()) {
            rest
        } else {
            stem
        }
    });
    let id = stem.strip_prefix("lib").unwrap_or(stem);
    (!id.is_empty()).then(|| id.to_string())
}

/// A log line split as the engine writes it, after the launcher's `[stderr] ` or `[stdout] `:
/// `{t:9.3} {LEVEL} [{target}] {message}`.
struct Record<'a> {
    level: &'a str,
    target: &'a str,
    message: &'a str,
}

fn record(line: &str) -> Option<Record<'_>> {
    let rest = line.trim_start();
    let rest = ["[stderr]", "[stdout]"]
        .iter()
        .find_map(|p| rest.strip_prefix(p))
        .unwrap_or(rest)
        .trim_start();
    let (time, rest) = rest.split_once(char::is_whitespace)?;
    time.parse::<f64>().ok()?;
    let (level, rest) = rest.trim_start().split_once(char::is_whitespace)?;
    let rest = rest.trim_start().strip_prefix('[')?;
    let (target, message) = rest.split_once("] ")?;
    Some(Record {
        level,
        target,
        message,
    })
}

/// The message of an engine ERROR line, if this is one.
fn engine_error(line: &str) -> Option<&str> {
    let r = record(line)?;
    (r.level == "ERROR" && r.target == "weft").then_some(r.message)
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn classify(line: &str) -> Option<ModFailure> {
    use ModFailure as F;
    let message = engine_error(line)?;
    let line = line.trim().to_string();
    let named = |prefix: &str| word_after(message, prefix).map(str::to_string);
    if message.contains("was built against another mod ABI") {
        return Some(F::WrongVersion {
            mod_id: named("mod "),
            line,
        });
    }
    // The engine always names the missing mod and the crate; a line without them isn't its.
    if message.contains(" requires missing mod ") {
        return Some(F::MissingDep {
            mod_id: named("mod "),
            dependency: named(" requires missing mod ")?,
            line,
        });
    }
    if message.contains(" is the crate ") {
        return Some(F::WrongName {
            mod_id: named("mod "),
            crate_name: named(" is the crate ")?,
            line,
        });
    }
    if let Some(id) = word_after(message, "loading mod ")
        && message.starts_with(&format!("loading mod {id} from "))
    {
        return Some(F::LoadFailed {
            mod_id: Some(id.to_string()),
            line,
        });
    }
    if let Some(at) = message.find(" is not a Weft mod") {
        return Some(F::NotAMod {
            mod_id: id_from_library(message[..at].trim()),
            line,
        });
    }
    if let Some(before) = message.trim_end().strip_suffix("init panicked") {
        // The engine prefixes each registration error with the mod's id: `showcase: init panicked`.
        let id = before
            .trim_end()
            .strip_suffix(':')
            .map(str::trim)
            .filter(|id| is_id(id));
        return Some(F::InitPanicked {
            mod_id: id.map(str::to_string),
            line,
        });
    }
    None
}

/// For an init panic, the mod named by the lines before it: the mod's own `[mod:X] panicked`
/// line, else the nearest `loading mod X`.
fn panicked_mod(before: &[String]) -> Option<String> {
    let from_panic = before.iter().rev().find_map(|l| {
        if !l.contains("panicked") {
            return None;
        }
        word_after(l, "[mod:").map(str::to_string)
    });
    from_panic.or_else(|| {
        before
            .iter()
            .rev()
            .find_map(|l| word_after(l, "loading mod ").map(str::to_string))
    })
}

/// The first mod failure in the log of one run.
pub fn find(log: &str) -> Option<ModFailure> {
    let lines: Vec<String> = log.lines().map(crate::launch::strip_ansi_codes).collect();
    lines.iter().enumerate().find_map(|(i, l)| {
        let mut failure = classify(l)?;
        if failure.kind() == FailureKind::InitPanicked && failure.mod_id().is_none() {
            *failure.mod_id_mut() = panicked_mod(&lines[..i]);
        }
        Some(failure)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use FailureKind as K;

    /// One fixture per kind, in the shape the launcher's log has: `[stderr]` from the launcher,
    /// then the engine's own `{t:9.3} {LEVEL} [{target}] {message}` with its colour codes
    /// (`crates/engine/src/log.rs`). The messages are the engine's `format!` strings in
    /// `crates/engine/src/modloader.rs` and `content.rs`, logged by `crates/app` (target `weft`).
    #[test]
    fn every_failure_kind() {
        // What, log, kind, mod, other.
        type Case<'a> = (&'a str, &'a str, K, Option<&'a str>, Option<&'a str>);
        let cases: &[Case] = &[
            (
                "wrong version",
                "[stderr] \x1b[90m    0.512\x1b[0m \x1b[1;31mERROR\x1b[0m \x1b[90m[weft]\x1b[0m mod structures was built against another mod ABI (5f0569a6bea71b81, this engine has f470b1cbb1f9ad91); rebuild it against the current weft_sdk",
                K::WrongVersion,
                Some("structures"),
                None,
            ),
            (
                "load failed",
                "[stderr]     0.402 ERROR [weft] loading mod cogwork from /home/u/.cache/weft/unpacked/cogwork-2642469-1793815500/libcogwork.so: undefined symbol: foo",
                K::LoadFailed,
                Some("cogwork"),
                None,
            ),
            (
                "not a mod",
                "[stderr]     0.402 ERROR [weft] /home/u/.cache/weft/unpacked/mytweak-1048-1793815500/libmytweak.so is not a Weft mod",
                K::NotAMod,
                Some("mytweak"),
                None,
            ),
            (
                "not a mod, path with spaces",
                r"[stderr]     0.402 ERROR [weft] C:\Users\Jo Doe\AppData\Local\weft\cache\unpacked\my_tweak-1048-1793815500\my_tweak.dll is not a Weft mod",
                K::NotAMod,
                Some("my_tweak"),
                None,
            ),
            (
                "wrong name",
                "[stderr]     0.402 ERROR [weft] mod cogworks is the crate cogwork: name its folder or zip cogwork",
                K::WrongName,
                Some("cogworks"),
                Some("cogwork"),
            ),
            (
                "missing dependency",
                "[stderr]     0.402 ERROR [weft] mod cogwork requires missing mod showcase",
                K::MissingDep,
                Some("cogwork"),
                Some("showcase"),
            ),
            (
                "init panic, named by the engine",
                "[stderr]     0.903 ERROR [weft] showcase: init panicked",
                K::InitPanicked,
                Some("showcase"),
                None,
            ),
        ];
        for (what, log, kind, id, other) in cases {
            let f = find(log).unwrap_or_else(|| panic!("{what}: nothing found"));
            assert_eq!(f.kind(), *kind, "{what}");
            assert_eq!(f.mod_id(), *id, "{what}");
            let named = match &f {
                ModFailure::MissingDep { dependency, .. } => Some(dependency.as_str()),
                ModFailure::WrongName { crate_name, .. } => Some(crate_name.as_str()),
                _ => None,
            };
            assert_eq!(named, *other, "{what}");
            assert!(!f.line().contains('\x1b'), "{what}: colour codes stripped");
        }
    }

    /// A path with `] ` in it doesn't move the message.
    #[test]
    fn paths_with_brackets() {
        let line =
            "[stderr]     0.402 ERROR [weft] /home/u/mods [old] /x/libmytweak.so is not a Weft mod";
        let f = find(line).unwrap();
        assert_eq!(f.kind(), K::NotAMod);
        assert_eq!(f.mod_id(), Some("mytweak"));
    }

    #[test]
    fn an_init_panic_names_the_mod() {
        // Several registration errors are joined with newlines into one ERROR record: only the
        // first line carries the prefix, and the first failure counts.
        let log = "\
[stderr]     0.101 INFO  [modloader] unpacked mod cogwork
[stderr]     0.101 INFO  [modloader] unpacked mod showcase
[stderr]     0.310 ERROR [mod:showcase] panicked at src/lib.rs:12: no tubes
[stderr]     0.320 ERROR [weft] showcase: init panicked
[stderr] cogwork: init panicked
";
        let f = find(log).unwrap();
        assert_eq!(f.kind(), K::InitPanicked);
        assert_eq!(f.mod_id(), Some("showcase"));

        // Without the prefix (older engines), the mod's own panic line names it.
        let log = "\
[stderr]     0.310 ERROR [mod:cogwork::pipes] panicked at src/pipes.rs:3: x
[stderr]     0.320 ERROR [weft] init panicked
";
        assert_eq!(find(log).unwrap().mod_id(), Some("cogwork"));

        let log = "\
[stderr]     0.200 DEBUG [weft] loading mod lanterns
[stderr]     0.320 ERROR [weft] init panicked
";
        assert_eq!(find(log).unwrap().mod_id(), Some("lanterns"));
    }

    /// What the page gets: one shape per kind, with only that kind's fields.
    #[test]
    fn each_kind_crosses_with_its_own_fields() {
        let f = find("[stderr]     0.402 ERROR [weft] mod cogwork requires missing mod showcase")
            .unwrap();
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({
                "kind": "missingDep",
                "modId": "cogwork",
                "dependency": "showcase",
                "line": "[stderr]     0.402 ERROR [weft] mod cogwork requires missing mod showcase"
            })
        );
        let f = find("[stderr]     0.402 ERROR [weft] mod cogworks is the crate cogwork: name its folder or zip cogwork").unwrap();
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(
            (v["kind"].as_str(), v["crate"].as_str()),
            (Some("wrongName"), Some("cogwork"))
        );
        let f = find("[stderr]     0.903 ERROR [weft] init panicked").unwrap();
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "kind": "initPanicked", "modId": null, "line": "[stderr]     0.903 ERROR [weft] init panicked" })
        );
    }

    #[test]
    fn ordinary_lines_are_not_failures() {
        for line in [
            "[stderr]     1.200 INFO  [modloader] loaded mod cogwork 0.2.0 (load position 1)",
            "[stderr]     0.101 INFO  [modloader] unpacked mod cogwork",
            "[stderr]     0.101 INFO  [modloader] mod cogwork is turned off",
            "[stderr]     0.101 WARN  [modloader] mod lanterns is off, as it needs one that is",
            "[stderr]    90.000 ERROR [mod:cogwork] panicked at src/lib.rs:1: later, in game",
            // The same words at another level, or in a mod's own chat, are not the engine's.
            "[stderr]     0.402 INFO  [mod:hints] loading mod cogwork from the cache",
            "[stderr]     0.402 WARN  [weft] mod cogwork requires missing mod showcase",
            "[stdout] <player> my build is not a Weft mod",
            // A mod's own ERROR lines name other mods; only the engine's count.
            "[stderr]     0.402 ERROR [mod:hints] mod cogwork requires missing mod showcase",
            "[stderr]     0.402 ERROR [mod:x] mod y was built against another mod ABI (1, this engine has 2)",
            "[stderr]     0.402 ERROR [modloader] showcase: init panicked",
            "ERROR [weft] mod cogwork requires missing mod showcase",
            "",
        ] {
            assert!(find(line).is_none(), "{line:?}");
        }
    }
}
