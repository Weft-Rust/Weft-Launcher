//! Ordering of mod versions such as `0.2.0`, `0.2.1-rc.1` and `0.1.2-experimental.4563878.917596d`:
//! semver precedence, which is all the mods use.

use std::cmp::Ordering;

fn split(v: &str) -> (Vec<u64>, Option<&str>) {
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split('+').next().unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let nums = core.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    (nums, pre)
}

fn cmp_pre(a: &str, b: &str) -> Ordering {
    let mut ai = a.split('.');
    let mut bi = b.split('.');
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

pub fn compare(a: &str, b: &str) -> Ordering {
    let (an, ap) = split(a);
    let (bn, bp) = split(b);
    let len = an.len().max(bn.len());
    for i in 0..len {
        let ord = an
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&bn.get(i).copied().unwrap_or(0));
        if ord != Ordering::Equal {
            return ord;
        }
    }
    match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => cmp_pre(x, y),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_precedence() {
        let mut v = vec![
            "0.2.0",
            "0.1.2",
            "0.2.1-rc.1",
            "0.2.1",
            "0.2.1-rc.2",
            "0.10.0",
        ];
        v.sort_by(|a, b| compare(a, b));
        assert_eq!(
            v,
            [
                "0.1.2",
                "0.2.0",
                "0.2.1-rc.1",
                "0.2.1-rc.2",
                "0.2.1",
                "0.10.0"
            ]
        );
        assert_eq!(compare("v1.0.0", "1.0"), Ordering::Equal);
    }
}
