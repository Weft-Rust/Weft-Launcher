//! The TypeScript side of every type that crosses IPC, generated with `ts-rs` into
//! `src/mods/bindings/` (one file per type, plus `index.ts` and `commands.ts`).
//!
//! `commands.ts` also maps every command to its arguments and result (`CommandSignatures`),
//! read from the command's own declaration, and every event to its payload (`EventPayloads`).
//! A renamed argument or a changed result type changes the page's types with it.
//!
//! `bindings_are_current` fails when the committed files differ from what the Rust types say.
//! To regenerate them: `cargo test export_bindings -- --ignored` in `src-tauri`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use ts_rs::{Config, TS};

use crate::error::{AppError, ErrorCode};
use crate::install::{InstallProgress, InstalledVersion};
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

/// Every command `lib.rs` registers, as written in its `generate_handler!` list
/// (`mods::commands::install_mod`).
pub(crate) fn command_paths() -> Vec<String> {
    let lib = include_str!("lib.rs");
    let start = lib
        .find("generate_handler![")
        .expect("generate_handler! in lib.rs");
    let list = &lib[start + "generate_handler![".len()..];
    let list = &list[..list.find(']').expect("end of generate_handler!")];
    list.split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn command_names() -> Vec<String> {
    command_paths()
        .iter()
        .map(|p| p.rsplit("::").next().unwrap().to_string())
        .collect()
}

/// A command's arguments as the page passes them, and its result.
#[derive(Debug, PartialEq)]
struct Signature {
    args: Vec<(String, String)>,
    result: String,
}

/// Splits at commas that aren't inside `<>` or `()`.
fn split_top(s: &str) -> Vec<&str> {
    let (mut depth, mut start, mut out) = (0i32, 0, Vec::new());
    for (i, c) in s.char_indices() {
        match c {
            '<' | '(' => depth += 1,
            '>' | ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(s[start..].trim());
    out.into_iter().filter(|p| !p.is_empty()).collect()
}

/// The TypeScript for a Rust type in a command signature. Named types must be exported
/// bindings; they are collected into `named`, and `export_into` fails if one isn't (a type
/// alias is such a name: write the type it stands for).
///
/// Numbers are TypeScript `number`, a double: integers past `Number.MAX_SAFE_INTEGER`
/// (2^53 − 1) would lose precision. Every 64-bit integer that crosses IPC today stays far below
/// that (sizes in bytes, capped at 512 MB for a mod and a few GB for a game version, timestamps,
/// revision counters); one that could pass it must cross as a string instead.
fn ts_type(rust: &str, named: &mut std::collections::BTreeSet<String>) -> String {
    let t = rust.trim();
    let inner = |prefix: &str| {
        t.strip_prefix(prefix)
            .and_then(|r| r.strip_suffix('>'))
            .map(str::to_string)
    };
    if let Some(i) = inner("Option<") {
        return format!("{} | null", ts_type(&i, named));
    }
    if let Some(i) = inner("Vec<") {
        return format!("Array<{}>", ts_type(&i, named));
    }
    match t {
        "String" | "&str" | "PathBuf" => "string".into(),
        "bool" => "boolean".into(),
        "()" => "void".into(),
        "u8" | "u16" | "u32" | "u64" | "usize" | "i32" | "i64" | "f64" => "number".into(),
        path => {
            let name = path.rsplit("::").next().unwrap();
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric()) && !name.is_empty(),
                "can't write {path:?} in TypeScript: a command's types are String, &str, PathBuf, \
                 bool, numbers, Option<…>, Vec<…>, (), and types exported to the bindings"
            );
            let name = if name == "AppError" {
                "AppErrorPayload"
            } else {
                name
            };
            named.insert(name.to_string());
            name.to_string()
        }
    }
}

/// Arguments the page doesn't pass: Tauri fills them in.
fn injected(rust_type: &str) -> bool {
    ["AppHandle", "State<", "Window", "Webview"]
        .iter()
        .any(|t| rust_type.contains(t))
}

/// Reads a command's signature from Rust source. The shapes it supports, and the only ones a
/// command may have:
///
/// - `pub async fn name(` or `pub fn name(`, with no generics and no `where` clause;
/// - arguments `name: Type`, without attributes or patterns, where `Type` is `String`, `&str`,
///   `PathBuf`, `bool`, a number, `Option<…>`, `Vec<…>`, or a type exported to the bindings;
///   `AppHandle`, `State<…>`, `Window` and `Webview` are filled in by Tauri and skipped;
/// - the result `-> Result<T, AppError>`, `-> T`, or none.
///
/// Anything else (a `#[tauri::command(rename_all = …)]`, an attribute on an argument, `impl`,
/// `&mut`, `dyn`, a lifetime) fails here with the command's name, rather than being read
/// wrongly.
fn signature_in(
    source: &str,
    name: &str,
    named: &mut std::collections::BTreeSet<String>,
) -> Signature {
    let (decl, start) = [format!("pub async fn {name}("), format!("pub fn {name}(")]
        .iter()
        .find_map(|p| source.find(p.as_str()).map(|at| (at, at + p.len())))
        .unwrap_or_else(|| panic!("no declaration of command {name} (generics aren't supported)"));
    let attribute = source[..decl].trim_end().lines().last().unwrap_or("");
    assert!(
        !attribute.contains("tauri::command("),
        "command {name}: options on #[tauri::command] aren't supported"
    );
    let rest = &source[start..];
    let mut depth = 1;
    let close = rest
        .char_indices()
        .find(|&(_, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            depth == 0
        })
        .map(|(i, _)| i)
        .expect("end of the argument list");
    let params = &rest[..close];
    for bad in ["#[", "impl ", "&mut", "dyn ", "'"] {
        assert!(
            !params.contains(bad),
            "command {name}: {bad:?} in its arguments isn't supported"
        );
    }
    let args = split_top(params)
        .into_iter()
        .filter_map(|param| {
            let (arg, ty) = param
                .split_once(':')
                .unwrap_or_else(|| panic!("command {name}: {param:?} is not name: Type"));
            assert!(
                arg.trim()
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
                "command {name}: argument {arg:?} isn't a plain name"
            );
            (!injected(ty)).then(|| (camel(arg.trim()), ts_type(ty, named)))
        })
        .collect();
    let after = &rest[close + 1..];
    let head = after[..after.find('{').expect("function body")].trim();
    assert!(
        !head.contains("where") && !head.contains("impl "),
        "command {name}: `where` and `impl` results aren't supported"
    );
    let ret = head.strip_prefix("->").map(str::trim).unwrap_or("()");
    let ok = ret
        .strip_prefix("Result<")
        .and_then(|r| r.strip_suffix('>'))
        .map(|r| split_top(r)[0].to_string())
        .unwrap_or_else(|| ret.to_string());
    Signature {
        args,
        result: ts_type(&ok, named),
    }
}

/// The source file of a module path like `mods::commands`.
fn module_source(module: &str) -> String {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let rel = module.replace("::", "/");
    [format!("{rel}.rs"), format!("{rel}/mod.rs")]
        .iter()
        .find_map(|f| std::fs::read_to_string(src.join(f)).ok())
        .unwrap_or_else(|| panic!("no source for module {module}"))
}

fn signatures(named: &mut std::collections::BTreeSet<String>) -> Vec<(String, Signature)> {
    command_paths()
        .iter()
        .map(|path| {
            let (module, name) = path.rsplit_once("::").expect("module::command");
            let sig = signature_in(&module_source(module), name, named);
            (name.to_string(), sig)
        })
        .collect()
}

/// Tauri passes arguments under their camelCase names (`asset_url` as `assetUrl`).
fn camel(snake: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in snake.trim_start_matches('_').chars() {
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
    let mut named = std::collections::BTreeSet::new();
    let sigs = signatures(&mut named);
    named.extend(crate::ipc::EVENTS.iter().map(|(_, _, t)| t.to_string()));
    let mut s = String::from(HEADER);
    s.push('\n');
    for t in &named {
        s.push_str(&format!("import type {{ {t} }} from \"./{t}\";\n"));
    }
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
    for (key, name, _) in crate::ipc::EVENTS {
        s.push_str(&format!("  {key}: \"{name}\",\n"));
    }
    s.push_str("} as const;\n\nexport type EventName = (typeof EVENTS)[keyof typeof EVENTS];\n");

    s.push_str(
        "\n/** Every command's arguments and result, read from its declaration in Rust. */\n\
         export interface CommandSignatures {\n",
    );
    for (name, sig) in &sigs {
        let args = if sig.args.is_empty() {
            "Record<string, never>".to_string()
        } else {
            let fields: Vec<String> = sig.args.iter().map(|(n, t)| format!("{n}: {t}")).collect();
            format!("{{ {} }}", fields.join("; "))
        };
        s.push_str(&format!(
            "  {name}: {{ args: {args}; result: {} }};\n",
            sig.result
        ));
    }
    s.push_str("}\n\n/** Every event's payload. */\nexport interface EventPayloads {\n");
    for (_, name, payload) in crate::ipc::EVENTS {
        s.push_str(&format!("  \"{name}\": {payload};\n"));
    }
    s.push_str("}\n");
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
        InstallProgress,
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
    let commands = commands_ts();
    for line in commands.lines().filter(|l| l.starts_with("import type")) {
        let module = line.rsplit("\"./").next().unwrap().trim_end_matches("\";");
        assert!(
            modules.iter().any(|m| m == module),
            "commands.ts names {module}, which no exported type is; add it to export_into"
        );
    }
    std::fs::write(dir.join("commands.ts"), commands).unwrap();
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
    assert_eq!(camel("expected_sha256"), "expectedSha256");
    assert_eq!(camel("_tag"), "tag");
}

#[test]
fn signatures_are_read_from_the_declarations() {
    let source = r#"
        #[tauri::command]
        pub async fn install_version(
            app_handle: tauri::AppHandle,
            tag: String,
            expected_sha256: Option<String>,
        ) -> Result<InstalledVersion, AppError> {
            todo!()
        }
        pub async fn list(app: AppHandle, force_refresh: bool) -> Result<Vec<String>, AppError> {}
        pub async fn open(app: AppHandle, _tag: String) -> Result<(), AppError> {}
    "#;
    let mut named = std::collections::BTreeSet::new();
    let sig = signature_in(source, "install_version", &mut named);
    assert_eq!(
        sig,
        Signature {
            args: vec![
                ("tag".into(), "string".into()),
                ("expectedSha256".into(), "string | null".into())
            ],
            result: "InstalledVersion".into(),
        }
    );
    let sig = signature_in(source, "list", &mut named);
    assert_eq!(
        sig.args,
        [("forceRefresh".to_string(), "boolean".to_string())]
    );
    assert_eq!(sig.result, "Array<string>");
    let sig = signature_in(source, "open", &mut named);
    assert_eq!(sig.args, [("tag".to_string(), "string".to_string())]);
    assert_eq!(sig.result, "void");
    assert_eq!(named.into_iter().collect::<Vec<_>>(), ["InstalledVersion"]);

    // Shapes it can't read are refused, by name.
    for (bad, why) in [
        (
            "#[tauri::command(rename_all = \"snake_case\")]\npub async fn a(x: String) {}",
            "options",
        ),
        ("pub async fn a(#[allow(x)] x: String) {}", "#["),
        ("pub async fn a(x: impl Into<String>) {}", "impl"),
        ("pub async fn a<T>(x: T) {}", "generics"),
        (
            "pub fn a(x: String) -> Result<T, E> where T: Clone {}",
            "where",
        ),
        ("pub fn a((x, y): (u8, u8)) {}", "plain name"),
    ] {
        let got = std::panic::catch_unwind(|| {
            signature_in(bad, "a", &mut std::collections::BTreeSet::new())
        });
        let message = got
            .err()
            .and_then(|e| e.downcast::<String>().ok())
            .map(|m| *m)
            .unwrap_or_else(|| panic!("{bad:?} was read"));
        assert!(message.contains(why), "{bad:?}: {message}");
    }

    // Containers nest; paths and the AppError payload are written by their exported name.
    let mut named = std::collections::BTreeSet::new();
    assert_eq!(
        ts_type("Option<Vec<Option<u64>>>", &mut named),
        "Array<number | null> | null"
    );
    assert_eq!(
        ts_type("Vec<crate::mods::catalog::Catalog>", &mut named),
        "Array<Catalog>"
    );
    assert_eq!(
        ts_type("crate::error::AppError", &mut named),
        "AppErrorPayload"
    );
    assert_eq!(
        named.into_iter().collect::<Vec<_>>(),
        ["AppErrorPayload", "Catalog"]
    );
    // What TypeScript can't be written for is refused with what can.
    for bad in [
        "HashMap<String, u8>",
        "(u8, u8)",
        "&String",
        "[u8; 4]",
        "Box<str>",
    ] {
        let got = std::panic::catch_unwind(|| ts_type(bad, &mut std::collections::BTreeSet::new()));
        let message = got
            .err()
            .and_then(|e| e.downcast::<String>().ok())
            .map(|m| *m)
            .unwrap_or_else(|| panic!("{bad:?} was written"));
        assert!(message.contains("Option<…>, Vec<…>"), "{bad:?}: {message}");
    }

    // Every registered command has one.
    let mut named = std::collections::BTreeSet::new();
    let all = signatures(&mut named);
    assert_eq!(all.len(), command_names().len());
    let restore = all.iter().find(|(n, _)| n == "restore_mod").unwrap();
    assert_eq!(restore.1.result, "ChangeResult");
}
