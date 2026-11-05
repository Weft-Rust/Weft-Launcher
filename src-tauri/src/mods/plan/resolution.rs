//! What an install brings: the builds it needs, transitively, and what is missing; whether a
//! build can be installed at all; and the set it leaves.

use super::*;

/// Whether this build may be installed here at all.
pub fn check_installable(
    catalog: &Catalog,
    m: &CatalogMod,
    v: &CatalogVersion,
    fit: Fit<'_>,
) -> Result<(), ModsError> {
    if m.id == RESERVED_ID {
        return Err(ModsError::IdReserved(m.id.clone()));
    }
    if let Some(r) = catalog.revocation(&v.sha256) {
        return Err(ModsError::Revoked(format!("{}: {}", m.name, r.detail())));
    }
    if !fit.platform_ok(v) {
        return Err(ModsError::NotForPlatform(m.name.clone()));
    }
    if v.abi != fit.abi {
        return Err(ModsError::Incompatible(m.name.clone()));
    }
    Ok(())
}

/// The builds to download for a change, and what else it turns on.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// The mods asked for, by id.
    pub wanted: Vec<String>,
    /// The wanted builds first, then the dependencies they pull in.
    pub picks: Vec<(CatalogMod, CatalogVersion)>,
    /// Installed mods the graph goes through, on or off, with what they need.
    pub installed: Vec<(String, Vec<String>)>,
    /// Installed dependencies that are off and would be turned on.
    pub enable: Vec<String>,
    pub missing: Vec<String>,
}

/// A mod the resolution walks through: a build it picks, or an installed mod.
enum Node {
    Pick(Box<(CatalogMod, CatalogVersion)>),
    Have(String),
}

/// The requested builds plus whatever they need that isn't on yet, through the whole graph. A
/// dependency that is installed, fits and isn't revoked is used (and turned on if off), and what
/// it needs is resolved in turn. Otherwise it comes from the index first, then from the same
/// source as the mod that needs it, and a revoked build is never picked: with nothing else, the
/// dependency is missing.
pub fn resolve(
    catalog: &Catalog,
    lock: &Lock,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    fit: Fit<'_>,
) -> Resolution {
    let mut res = Resolution {
        wanted: wanted.iter().map(|(m, _)| m.id.clone()).collect(),
        picks: Vec::new(),
        installed: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
    };
    let node_id = |n: &Node| match n {
        Node::Pick(p) => p.0.id.clone(),
        Node::Have(id) => id.clone(),
    };
    let mut todo: std::collections::VecDeque<Node> = wanted
        .into_iter()
        .map(|p| Node::Pick(Box::new(p)))
        .collect();
    while let Some(node) = todo.pop_front() {
        let id = node_id(&node);
        if res.picks.iter().any(|(p, _)| p.id == id) || res.installed.iter().any(|(i, _)| *i == id)
        {
            continue;
        }
        let (deps, origin, channel) = match &node {
            Node::Pick(p) => (p.1.deps.clone(), p.0.origin.clone(), p.1.channel),
            Node::Have(id) => {
                let e = lock.get(id).expect("an installed node is in the lock");
                (
                    e.deps.clone(),
                    e.origin.clone(),
                    e.channel.unwrap_or(Channel::Release),
                )
            }
        };
        for dep in &deps {
            if BUILTIN.contains(&dep.as_str())
                || res.picks.iter().any(|(p, _)| &p.id == dep)
                || res.installed.iter().any(|(i, _)| i == dep)
                || todo.iter().any(|n| &node_id(n) == dep)
                || res.missing.contains(dep)
            {
                continue;
            }
            if let Some(have) = lock.get(dep)
                && have.abi.as_deref().is_none_or(|a| a == fit.abi)
                && !have.is_revoked(catalog)
            {
                if !have.enabled && !res.enable.contains(dep) {
                    res.enable.push(dep.clone());
                }
                todo.push_back(Node::Have(dep.clone()));
                continue;
            }
            let mut keys = vec![format!("index:{dep}")];
            if let Origin::Source { repo } = &origin {
                keys.push(format!("source:{repo}:{dep}"));
            }
            match keys
                .iter()
                .find_map(|k| best_version(catalog, k, fit, channel))
            {
                Some((dm, dv)) => todo.push_back(Node::Pick(Box::new((dm.clone(), dv.clone())))),
                None => res.missing.push(dep.clone()),
            }
        }
        match node {
            Node::Pick(p) => res.picks.push(*p),
            Node::Have(id) => res.installed.push((id, deps)),
        }
    }
    res
}

impl Resolution {
    /// What `id` needs: its picked build's dependencies, else the installed mod's.
    fn deps_of(&self, id: &str) -> &[String] {
        self.picks
            .iter()
            .find(|(m, _)| m.id == id)
            .map(|(_, v)| v.deps.as_slice())
            .or_else(|| {
                self.installed
                    .iter()
                    .find(|(i, _)| i == id)
                    .map(|(_, d)| d.as_slice())
            })
            .unwrap_or(&[])
    }

    /// Whether the graph goes through `id`, as a pick or an installed mod.
    fn has_node(&self, id: &str) -> bool {
        self.picks.iter().any(|(m, _)| m.id == id) || self.installed.iter().any(|(i, _)| i == id)
    }

    /// Whether `id`, through the whole graph, needs something missing.
    fn needs_missing(&self, id: &str) -> bool {
        let mut seen = BTreeSet::new();
        let mut todo = vec![id.to_string()];
        while let Some(next) = todo.pop() {
            if !seen.insert(next.clone()) {
                continue;
            }
            for dep in self.deps_of(&next) {
                if self.missing.contains(dep) {
                    return true;
                }
                todo.push(dep.clone());
            }
        }
        false
    }
}

/// What committing a resolution to a lock does to on and off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// Picked and installed mods that end up on because a wanted mod that ends up on needs them,
    /// and those wanted mods.
    pub on: BTreeSet<String>,
    /// Installed mods that are off and are turned on.
    pub enable: Vec<String>,
    /// Wanted mods that are installed turned off, because something they need is missing.
    pub installed_off: Vec<String>,
}

/// A wanted mod ends up on when it is new or on now, and needs nothing missing; what it needs
/// ends up on with it. A wanted mod that is off stays off after an update, and so does what it
/// brings along.
pub fn outcome(lock: &Lock, res: &Resolution) -> Outcome {
    let mut installed_off = Vec::new();
    let mut todo = Vec::new();
    for id in &res.wanted {
        if res.needs_missing(id) {
            installed_off.push(id.clone());
        } else if lock.get(id).is_none_or(|e| e.enabled) {
            todo.push(id.clone());
        }
    }
    let mut on = BTreeSet::new();
    while let Some(id) = todo.pop() {
        if !on.insert(id.clone()) {
            continue;
        }
        for dep in res.deps_of(&id) {
            if res.has_node(dep) {
                todo.push(dep.clone());
            }
        }
    }
    let enable = res
        .enable
        .iter()
        .filter(|id| on.contains(*id))
        .cloned()
        .collect();
    Outcome {
        on,
        enable,
        installed_off,
    }
}

pub struct Committed {
    pub installed: Vec<String>,
    pub also_enabled: Vec<String>,
    pub installed_off: Vec<String>,
}

/// Writes a resolution into the lock, following [`outcome`].
pub fn commit(lock: &mut Lock, res: &Resolution) -> Committed {
    let out = outcome(lock, res);
    let mut installed = Vec::new();
    for (m, v) in &res.picks {
        let was_on = lock.get(&m.id).is_some_and(|e| e.enabled);
        let wanted = res.wanted.contains(&m.id);
        let enabled = out.on.contains(&m.id) || (!wanted && was_on);
        lock.put(LockEntry::from_catalog(m, v, enabled));
        installed.push(m.id.clone());
    }
    let mut also_enabled = Vec::new();
    for id in &out.enable {
        if let Some(e) = lock.get_mut(id)
            && !e.enabled
        {
            e.enabled = true;
            also_enabled.push(id.clone());
        }
    }
    Committed {
        installed,
        also_enabled,
        installed_off: out.installed_off,
    }
}
