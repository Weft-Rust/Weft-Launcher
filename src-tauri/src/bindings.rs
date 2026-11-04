//! The TypeScript side of every type that crosses IPC, generated with `ts-rs` into
//! `src/mods/bindings/` (one file per type, plus `index.ts` and `commands.ts`).
//!
//! `bindings_are_current` fails when the committed files differ from what the Rust types say.
//! To regenerate them: `cargo test export_bindings -- --ignored` in `src-tauri`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use ts_rs::{Config, TS};

use crate::error::{AppError, ErrorCode};
use crate::install::InstalledVersion;
use crate::launch::GameStateEvent;
use crate::mods::catalog::Catalog;
use crate::mods::diagnose::{FailureKind, ModFailure};
use crate::mods::inspect::FileInspection;
use crate::mods::install::{ModProgress, ProgressStage};
use crate::mods::plan::{
    ChangeResult, CopyItem, CopyOutcome, CopyPreview, CopyResult, InstallPlan,
};
use crate::mods::profile::ProfileReport;
use crate::releases::Release;

fn committed_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/mods/bindings")
}

const HEADER: &str =
    "// Generated from the Rust types by src-tauri/src/bindings.rs. Do not edit.\n";

/// Every command `lib.rs` registers, read from its `generate_handler!` list.
fn command_names() -> Vec<String> {
    let lib = include_str!("lib.rs");
    let start = lib
        .find("generate_handler![")
        .expect("generate_handler! in lib.rs");
    let list = &lib[start + "generate_handler![".len()..];
    let list = &list[..list.find(']').expect("end of generate_handler!")];
    list.split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| p.rsplit("::").next().unwrap().to_string())
        .collect()
}

fn camel(snake: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in snake.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn commands_ts() -> String {
    let mut s = String::from(HEADER);
    s.push_str(
        "\n/** Every Tauri command, by the name `invoke` takes. */\nexport const COMMANDS = {\n",
    );
    for name in command_names() {
        s.push_str(&format!("  {}: \"{name}\",\n", camel(&name)));
    }
    s.push_str(
        "} as const;\n\nexport type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];\n",
    );
    s.push_str("\n/** Every event the backend emits. */\nexport const EVENTS = {\n");
    for (key, name) in crate::ipc::EVENTS {
        s.push_str(&format!("  {key}: \"{name}\",\n"));
    }
    s.push_str("} as const;\n\nexport type EventName = (typeof EVENTS)[keyof typeof EVENTS];\n");
    s
}

/// Writes every binding into `dir`, which must exist.
fn export_into(dir: &Path) {
    let cfg = Config::new().with_large_int("number").with_out_dir(dir);
    macro_rules! export {
        ($($t:ty),* $(,)?) => {
            $( <$t>::export_all(&cfg).expect(stringify!($t)); )*
        };
    }
    export!(
        AppError,
        ErrorCode,
        Catalog,
        ProfileReport,
        ChangeResult,
        CopyResult,
        CopyItem,
        CopyOutcome,
        CopyPreview,
        InstallPlan,
        FileInspection,
        ModProgress,
        ProgressStage,
        ModFailure,
        FailureKind,
        GameStateEvent,
        Release,
        InstalledVersion,
    );

    let mut modules: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().to_string_lossy().to_string();
            name.strip_suffix(".ts").map(str::to_string)
        })
        .collect();
    modules.sort();
    let mut index = String::from(HEADER);
    index.push('\n');
    for m in &modules {
        index.push_str(&format!("export type * from \"./{m}\";\n"));
    }
    index.push_str("export * from \"./commands\";\n");
    std::fs::write(dir.join("index.ts"), index).unwrap();
    std::fs::write(dir.join("commands.ts"), commands_ts()).unwrap();
}

fn read_all(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "ts"))
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let text = std::fs::read_to_string(e.path()).unwrap();
                    (name, text.replace("\r\n", "\n"))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn bindings_are_current() {
    let tmp = tempfile::tempdir().unwrap();
    export_into(tmp.path());
    let fresh = read_all(tmp.path());
    let committed = read_all(&committed_dir());
    let mut stale: Vec<&str> = fresh
        .iter()
        .filter(|(name, text)| committed.get(*name) != Some(*text))
        .map(|(name, _)| name.as_str())
        .collect();
    stale.extend(
        committed
            .keys()
            .filter(|name| !fresh.contains_key(*name))
            .map(String::as_str),
    );
    assert!(
        stale.is_empty(),
        "src/mods/bindings is out of date ({}).\n\
         Regenerate it with `cargo test export_bindings -- --ignored` in src-tauri, then commit it.",
        stale.join(", ")
    );
}

#[test]
#[ignore = "writes src/mods/bindings; run on purpose"]
fn export_bindings() {
    let dir = committed_dir();
    std::fs::create_dir_all(&dir).unwrap();
    for name in read_all(&dir).keys() {
        std::fs::remove_file(dir.join(name)).unwrap();
    }
    export_into(&dir);
}

#[test]
fn every_command_is_listed() {
    let names = command_names();
    for expected in [
        "list_mod_catalog",
        "plan_mod_install",
        "preview_copy_mod_profile",
        "launch_version",
    ] {
        assert!(names.iter().any(|n| n == expected), "{expected}");
    }
    assert_eq!(camel("preview_copy_mod_profile"), "previewCopyModProfile");
}
