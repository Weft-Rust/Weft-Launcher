//! What the player agrees to, as a token, and whether a plan still holds under the lock.

use super::*;

/// What the player agrees to when confirming a plan, as the backend can recompute it: every
/// build that will be installed (hash and trust), every mod that ends up on, what is turned on,
/// what is installed off, what is missing, and the version's mod interface. Its [`token`]
/// (`planToken`) is opaque to the page.
///
/// [`token`]: Consent::token
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    abi: Option<String>,
    wanted: Vec<String>,
    builds: Vec<String>,
    on: Vec<String>,
    enable: Vec<String>,
    installed_off: Vec<String>,
    missing: Vec<String>,
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

impl Consent {
    pub fn of(abi: Option<&str>, res: &Resolution, out: &Outcome) -> Consent {
        Consent {
            abi: abi.map(str::to_string),
            wanted: sorted(res.wanted.clone()),
            builds: sorted(
                res.picks
                    .iter()
                    .map(|(m, v)| build_text(&m.id, &v.sha256, v.trust))
                    .collect(),
            ),
            on: out.on.iter().cloned().collect(),
            enable: sorted(out.enable.clone()),
            installed_off: sorted(out.installed_off.clone()),
            missing: sorted(res.missing.clone()),
        }
    }

    /// A file that isn't in the catalogue: one Unverified build, on or off.
    pub fn unverified(abi: Option<&str>, id: &str, sha256: &str, on: bool) -> Consent {
        Consent {
            abi: abi.map(str::to_string),
            wanted: vec![id.to_string()],
            builds: vec![build_text(id, sha256, Trust::Unverified)],
            on: if on { vec![id.to_string()] } else { Vec::new() },
            enable: Vec::new(),
            installed_off: Vec::new(),
            missing: Vec::new(),
        }
    }

    pub fn token(&self) -> String {
        let list = |v: &[String]| v.join(",");
        let text = format!(
            "weft-plan/1\nabi={}\nwanted={}\nbuilds={}\non={}\nenable={}\noff={}\nmissing={}\n",
            self.abi.as_deref().unwrap_or("?"),
            list(&self.wanted),
            list(&self.builds),
            list(&self.on),
            list(&self.enable),
            list(&self.installed_off),
            list(&self.missing),
        );
        sha256_hex(text.as_bytes())
    }
}

fn build_text(id: &str, sha256: &str, trust: Trust) -> String {
    format!("{id}={}:{trust:?}", sha256.to_ascii_lowercase())
}

/// The token of a resolution, with the version's mod interface.
pub fn plan_token(abi: Option<&str>, lock: &Lock, res: &Resolution) -> String {
    Consent::of(abi, res, &outcome(lock, res)).token()
}

/// The token of a plan that can't be resolved, because the version's mod interface is unknown.
pub(super) fn unresolved_token(m: &CatalogMod, v: &CatalogVersion) -> String {
    let res = Resolution {
        wanted: vec![m.id.clone()],
        picks: vec![(m.clone(), v.clone())],
        installed: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
    };
    let out = Outcome {
        on: BTreeSet::new(),
        enable: Vec::new(),
        installed_off: Vec::new(),
    };
    Consent::of(None, &res, &out).token()
}

/// Whether a resolution made before a download still describes what committing now would do.
/// `before` is the lock and resolution the player agreed to; `now` the same against the latest
/// lock and catalogue. It holds when nothing more needs downloading, nothing more is turned on,
/// and each wanted mod ends up on or off as agreed. Otherwise, why not.
pub fn still_holds(before: (&Lock, &Resolution), now: (&Lock, &Resolution)) -> Result<(), String> {
    let (old_lock, old) = before;
    let (lock, new) = now;
    for (m, v) in &new.picks {
        if !old.picks.iter().any(|(_, o)| o.sha256 == v.sha256) {
            return Err(format!("{} {} is needed now", m.name, v.version));
        }
    }
    let (was, will) = (outcome(old_lock, old), outcome(lock, new));
    if let Some(id) = will.enable.iter().find(|id| !was.enable.contains(*id)) {
        return Err(format!("{} would be turned on too", lock.name_of(id)));
    }
    for id in &new.wanted {
        if was.on.contains(id) != will.on.contains(id) {
            let state = if will.on.contains(id) { "on" } else { "off" };
            return Err(format!("{} would end up {state}", lock.name_of(id)));
        }
    }
    Ok(())
}
