//! Names the mod that stopped the game from starting. Weft exits with code 1 and leaves the
//! reason in its log; these are the engine's own messages (`crates/engine/src/modloader.rs`).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModFailure {
    /// `wrongVersion`, `loadFailed`, `notAMod`, `wrongName`, `missingDep` or `initPanicked`.
    pub kind: &'static str,
    pub mod_id: Option<String>,
    /// For `missingDep`: the mod that is missing.
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

fn classify(line: &str) -> Option<ModFailure> {
    let failure = |kind, mod_id: Option<&str>, other: Option<&str>| ModFailure {
        kind,
        mod_id: mod_id.map(str::to_string),
        other: other.map(str::to_string),
        line: line.trim().to_string(),
    };
    if line.contains("was built against another mod ABI") {
        return Some(failure("wrongVersion", word_after(line, "mod "), None));
    }
    if line.contains(" requires missing mod ") {
        return Some(failure(
            "missingDep",
            word_after(line, "mod "),
            word_after(line, " requires missing mod "),
        ));
    }
    if line.contains(" is the crate ") {
        return Some(failure("wrongName", word_after(line, "mod "), None));
    }
    if line.contains("loading mod ") {
        return Some(failure(
            "loadFailed",
            word_after(line, "loading mod "),
            None,
        ));
    }
    if let Some(at) = line.find(" is not a Weft mod") {
        let path = line[..at].rsplit(' ').next().unwrap_or("");
        return Some(ModFailure {
            mod_id: id_from_library(path),
            ..failure("notAMod", None, None)
        });
    }
    if line.contains("init panicked") {
        return Some(failure("initPanicked", None, None));
    }
    None
}

/// The first mod failure in the log of one run.
pub fn find(log: &str) -> Option<ModFailure> {
    log.lines()
        .map(crate::launch::strip_ansi_codes)
        .find_map(|l| classify(&l))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_messages() {
        let log = "[stderr] \x1b[31mERROR\x1b[0m weft: mod structures was built against another mod ABI (5f0569a6bea71b81, this engine has f470b1cbb1f9ad91); rebuild it\n";
        let f = find(log).unwrap();
        assert_eq!(f.kind, "wrongVersion");
        assert_eq!(f.mod_id.as_deref(), Some("structures"));

        let f = find("ERROR mod cogwork requires missing mod showcase").unwrap();
        assert_eq!(
            (f.kind, f.mod_id.as_deref(), f.other.as_deref()),
            ("missingDep", Some("cogwork"), Some("showcase"))
        );

        let f =
            find("ERROR /home/u/.cache/weft/mods/4242-libmytweak.so is not a Weft mod").unwrap();
        assert_eq!((f.kind, f.mod_id.as_deref()), ("notAMod", Some("mytweak")));

        let f = find("ERROR loading mod cogwork from /x/libcogwork.so: undefined symbol").unwrap();
        assert_eq!(
            (f.kind, f.mod_id.as_deref()),
            ("loadFailed", Some("cogwork"))
        );

        assert!(find("INFO loaded mod cogwork 0.2.0 (load position 1)").is_none());
    }
}
