//! What an install brings, worked out from the index before anything is downloaded.

use std::collections::BTreeMap;

use serde::Serialize;

use super::index::Index;
use super::profile::{Installed, Profile};
use super::{BASE, ModError};

/// One file an install brings, from the index.
#[derive(Debug, Clone, Serialize)]
pub struct Planned {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) version: String,
    pub(super) repo: String,
    pub(super) tag: String,
    pub(super) abi: String,
    pub(super) deps: Vec<String>,
    pub(super) sha256: String,
}

/// What an install brings, from the index alone: each of `todo` and every mod they need,
/// through the whole chain. An installed mod that fits stays; any other is planned at its
/// newest build for `abi`. A `todo` with a version is always planned at that version.
pub(super) fn plan(
    index: &Index,
    profile: &Profile,
    installed: &BTreeMap<String, Installed>,
    abi: &str,
    mut todo: Vec<(String, Option<String>)>,
) -> Result<Vec<Planned>, ModError> {
    let mut plan: Vec<Planned> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    while let Some((id, version)) = todo.pop() {
        if id == BASE || kept.contains(&id) || plan.iter().any(|p| p.id == id) {
            continue;
        }
        if let (None, Some(m)) = (&version, installed.get(&id))
            && profile.fits(m, index).is_ok()
        {
            todo.extend(m.manifest.deps.iter().map(|d| (d.clone(), None)));
            kept.push(id);
            continue;
        }
        let found = match &version {
            None => index.newest(&id, abi),
            Some(v) => index.find(&id).and_then(|m| {
                let b = m.builds.iter().find(|b| &b.version == v && b.abi == abi)?;
                index.revoked(&b.sha256).is_none().then_some((m, b))
            }),
        };
        let Some((m, b)) = found else {
            let name = index.find(&id).map_or(id, |m| m.name.clone());
            return Err(ModError::NoBuildForVersion(name));
        };
        todo.extend(b.deps.iter().map(|d| (d.clone(), None)));
        plan.push(Planned {
            id: m.id.clone(),
            name: m.name.clone(),
            version: b.version.clone(),
            repo: m.repo.clone(),
            tag: b.tag.clone(),
            abi: b.abi.clone(),
            deps: b.deps.clone(),
            sha256: b.sha256.clone(),
        });
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::super::Dirs;
    use super::super::archive::Manifest;
    use super::super::index::{Build, IndexMod, Revoked};
    use super::*;
    use std::path::PathBuf;

    const ABI: &str = "aaaaaaaaaaaaaaaa";

    fn indexed(id: &str, name: &str, builds: &[(&str, &[&str])]) -> IndexMod {
        let builds = builds.iter().map(|(v, deps)| Build {
            version: v.to_string(),
            tag: format!("{id}-v{v}"),
            abi: ABI.into(),
            deps: deps.iter().map(|d| d.to_string()).collect(),
            sha256: format!("{id}{v}"),
        });
        IndexMod {
            id: id.into(),
            name: name.into(),
            summary: String::new(),
            repo: "o/r".into(),
            builds: builds.collect(),
        }
    }

    fn installed(id: &str, deps: &[&str], sha256: &str) -> (String, Installed) {
        let deps = deps.iter().map(|d| d.to_string()).collect();
        let manifest = Manifest {
            id: id.into(),
            name: String::new(),
            version: "0.1.0".into(),
            abi: ABI.into(),
            deps,
        };
        (
            id.to_string(),
            Installed {
                manifest,
                sha256: sha256.into(),
                on: false,
                bare: false,
            },
        )
    }

    #[test]
    fn plan_walks_the_whole_chain() {
        let mut index = Index {
            mods: vec![
                indexed(
                    "cogwork",
                    "Cogwork",
                    &[("0.2.0", &["base", "tubes", "glow"])],
                ),
                indexed(
                    "tubes",
                    "Tubes",
                    &[("1.0.0", &["glow"]), ("1.1.0", &["glow"])],
                ),
                indexed("glow", "Glowmoss", &[("0.3.0", &[])]),
            ],
            ..Index::default()
        };
        let profile = Profile::new(&Dirs::new(PathBuf::from("/nonexistent")), "v1");
        let cogwork = || vec![("cogwork".to_string(), Some("0.2.0".to_string()))];
        let ids = |plan: Result<Vec<Planned>, ModError>| {
            let plan = plan.unwrap().into_iter().map(|p| p.id + " " + &p.version);
            plan.collect::<Vec<_>>()
        };

        let none = BTreeMap::new();
        let all = plan(&index, &profile, &none, ABI, cogwork());
        assert_eq!(ids(all), ["cogwork 0.2.0", "glow 0.3.0", "tubes 1.1.0"]);

        // An installed Tubes stays, but the Glowmoss it needs is still brought.
        let tubes = BTreeMap::from([installed("tubes", &["glow"], "t")]);
        assert_eq!(
            ids(plan(&index, &profile, &tubes, ABI, cogwork())),
            ["cogwork 0.2.0", "glow 0.3.0"]
        );

        // A revoked one is replaced.
        index.revoked.push(Revoked {
            sha256: "t".into(),
            reason: None,
        });
        let replaced = plan(&index, &profile, &tubes, ABI, cogwork());
        assert_eq!(
            ids(replaced),
            ["cogwork 0.2.0", "glow 0.3.0", "tubes 1.1.0"]
        );

        let err = plan(&index, &profile, &none, "bbbbbbbbbbbbbbbb", cogwork()).unwrap_err();
        assert!(matches!(err, ModError::NoBuildForVersion(ref n) if n == "Cogwork"));
    }
}
