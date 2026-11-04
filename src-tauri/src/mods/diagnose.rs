//! Names the mod that stopped the game from starting. Weft exits with code 1 and leaves the
//! reason in its log; these are the engine's own messages (`crates/engine/src/modloader.rs`).

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
    /// `init panicked`, after the mod's own `[mod:X] panicked at …`
    InitPanicked,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModFailure {
    pub kind: FailureKind,
    pub mod_id: Option<String>,
    /// For `missingDep`: the mod that is missing. For `wrongName`: the crate the library is.
    pub other: Option<String>,
    /// The log line, so the player can search for it.
    pub line: String,
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

/// The message part of a log line: after the last `[target] `, which may hold spaces in a path.
fn message(line: &str) -> &str {
    line.rfind("] ").map_or(line, |i| &line[i + 2..])
}

fn classify(line: &str) -> Option<ModFailure> {
    use FailureKind as K;
    let failure = |kind, mod_id: Option<&str>, other: Option<&str>| ModFailure {
        kind,
        mod_id: mod_id.map(str::to_string),
        other: other.map(str::to_string),
        line: line.trim().to_string(),
    };
    if line.contains("was built against another mod ABI") {
        return Some(failure(K::WrongVersion, word_after(line, "mod "), None));
    }
    if line.contains(" requires missing mod ") {
        return Some(failure(
            K::MissingDep,
            word_after(line, "mod "),
            word_after(line, " requires missing mod "),
        ));
    }
    if line.contains(" is the crate ") {
        return Some(failure(
            K::WrongName,
            word_after(line, "mod "),
            word_after(line, " is the crate "),
        ));
    }
    if let Some(id) = word_after(line, "loading mod ")
        && line.contains(&format!("loading mod {id} from "))
    {
        return Some(failure(K::LoadFailed, Some(id), None));
    }
    if let Some(at) = line.find(" is not a Weft mod") {
        let path = message(&line[..at]).trim();
        return Some(ModFailure {
            mod_id: id_from_library(path),
            ..failure(K::NotAMod, None, None)
        });
    }
    if line.contains("init panicked") {
        return Some(failure(K::InitPanicked, None, None));
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
        if failure.kind == FailureKind::InitPanicked {
            failure.mod_id = panicked_mod(&lines[..i]);
        }
        Some(failure)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use FailureKind as K;

    /// One fixture per kind, in the shape the launcher's log has: `[stderr]` from the launcher,
    /// then the engine's own `<time> <LEVEL> [<target>] <message>`, with colour codes.
    #[test]
    fn every_failure_kind() {
        // What, log, kind, mod, other.
        type Case<'a> = (&'a str, &'a str, K, Option<&'a str>, Option<&'a str>);
        let cases: &[Case] = &[
            (
                "wrong version",
                "[stderr] \x1b[90m    0.512\x1b[0m \x1b[1;31mERROR\x1b[0m \x1b[90m[app]\x1b[0m mod structures was built against another mod ABI (5f0569a6bea71b81, this engine has f470b1cbb1f9ad91); rebuild it against the current weft_sdk",
                K::WrongVersion,
                Some("structures"),
                None,
            ),
            (
                "load failed",
                "[stderr]     0.40 ERROR [app] loading mod cogwork from /x/mods/libcogwork.so: undefined symbol: foo",
                K::LoadFailed,
                Some("cogwork"),
                None,
            ),
            (
                "not a mod",
                "[stderr]     0.40 ERROR [app] /home/u/.cache/weft/mods/4242-libmytweak.so is not a Weft mod",
                K::NotAMod,
                Some("mytweak"),
                None,
            ),
            (
                "not a mod, path with spaces",
                r"[stderr]     0.40 ERROR [app] C:\Users\Jo Doe\AppData\Weft Cache\mods\77-my_tweak.dll is not a Weft mod",
                K::NotAMod,
                Some("my_tweak"),
                None,
            ),
            (
                "wrong name",
                "[stderr]     0.40 ERROR [app] mod cogworks is the crate cogwork: name its folder or zip cogwork",
                K::WrongName,
                Some("cogworks"),
                Some("cogwork"),
            ),
            (
                "missing dependency",
                "[stderr]     0.40 ERROR [app] mod cogwork requires missing mod showcase",
                K::MissingDep,
                Some("cogwork"),
                Some("showcase"),
            ),
            (
                "init panic without context",
                "[stderr]     0.90 ERROR [app] init panicked",
                K::InitPanicked,
                None,
                None,
            ),
        ];
        for (what, log, kind, id, other) in cases {
            let f = find(log).unwrap_or_else(|| panic!("{what}: nothing found"));
            assert_eq!(f.kind, *kind, "{what}");
            assert_eq!(f.mod_id.as_deref(), *id, "{what}");
            assert_eq!(f.other.as_deref(), *other, "{what}");
            assert!(!f.line.contains('\x1b'), "{what}: colour codes stripped");
        }
    }

    #[test]
    fn an_init_panic_names_the_mod_from_the_lines_before() {
        let log = "\
[stderr]     0.10 INFO  [modloader] unpacked mod cogwork
[stderr]     0.10 INFO  [modloader] unpacked mod showcase
[stderr]     0.31 ERROR [mod:showcase] panicked at src/lib.rs:12:5: no tubes
[stderr]     0.32 ERROR [app] init panicked
";
        let f = find(log).unwrap();
        assert_eq!(f.kind, K::InitPanicked);
        assert_eq!(f.mod_id.as_deref(), Some("showcase"));

        let log = "\
[stderr] ERROR [mod:cogwork::pipes] panicked at src/pipes.rs:3:1: x
[stderr] ERROR [app] init panicked
";
        assert_eq!(find(log).unwrap().mod_id.as_deref(), Some("cogwork"));

        let log = "\
[stderr] DEBUG loading mod lanterns
[stderr] ERROR [app] init panicked
";
        assert_eq!(find(log).unwrap().mod_id.as_deref(), Some("lanterns"));
    }

    #[test]
    fn ordinary_lines_are_not_failures() {
        for line in [
            "INFO loaded mod cogwork 0.2.0 (load position 1)",
            "INFO [modloader] unpacked mod cogwork",
            "INFO [modloader] mod cogwork is turned off",
            "WARN [modloader] mod lanterns is off, as it needs one that is",
            "ERROR [mod:cogwork] panicked at src/lib.rs:1:1: later, in game",
            "",
        ] {
            assert!(find(line).is_none(), "{line:?}");
        }
    }
}
