//! Getting the files an install brings. Each one is downloaded into a fresh folder and checked
//! before anything is placed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use super::plan::Planned;
use super::{Dirs, ModError, archive, index, verify};

/// A new folder in `downloads/` for one install, deleted when it's dropped. The launcher also
/// empties `downloads/` at every start.
pub struct Staging(pub PathBuf);

impl Staging {
    pub fn new(dirs: &Dirs) -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = dirs.downloads().join(format!("mods-{n}"));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    pub fn zip(&self, id: &str) -> PathBuf {
        self.0.join(format!("{id}.zip"))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    tag: String,
    file: usize,
    files: usize,
    name: String,
    /// `None` once the downloads are done and the files are checked.
    percent: Option<u8>,
}

async fn download(url: &str, dest: &Path, mut progress: impl FnMut(u8)) -> Result<(), ModError> {
    let response = index::http().get(url).send().await?.error_for_status()?;
    let total = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = response.bytes_stream();
    let mut done = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        done += chunk.len() as u64;
        if done > archive::MAX_ZIP {
            return Err(ModError::NotAMod(format!("{url}: larger than 512 MB")));
        }
        file.write_all(&chunk).await?;
        if let Some(pct) = (done * 100).checked_div(total) {
            progress(pct.min(100) as u8);
        }
    }
    file.flush().await?;
    Ok(())
}

/// Downloads every planned file into `staging` and checks it.
pub async fn fetch(
    app: &AppHandle,
    staging: &Staging,
    tag: &str,
    plan: &[Planned],
) -> Result<(), ModError> {
    let files = plan.len();
    let emit = |file: usize, name: &str, percent: Option<u8>| {
        let (tag, name) = (tag.to_string(), name.to_string());
        let _ = app.emit(
            "mods-progress",
            Progress {
                tag,
                file,
                files,
                name,
                percent,
            },
        );
    };
    for (i, p) in plan.iter().enumerate() {
        let url = format!(
            "https://github.com/{}/releases/download/{}/{}",
            p.repo, p.tag, p.id
        );
        let zip = staging.zip(&p.id);
        download(&format!("{url}.zip"), &zip, |pct| {
            emit(i + 1, &p.name, Some(pct))
        })
        .await?;
        download(
            &format!("{url}.mod.json"),
            &zip.with_extension("mod.json"),
            |_| {},
        )
        .await?;
    }
    if let Some(p) = plan.last() {
        emit(files, &p.name, None);
    }
    for p in plan {
        let (p, zip) = (p.clone(), staging.zip(&p.id));
        let check = tauri::async_runtime::spawn_blocking(move || check(&p, &zip));
        check
            .await
            .map_err(|e| ModError::Io(std::io::Error::other(e)))??;
    }
    Ok(())
}

/// Steps 2 to 5 of an install: the pinned hash, the attestation, the zip, and that its
/// manifest says what the index says.
fn check(p: &Planned, zip: &Path) -> Result<(), ModError> {
    let sha256 = verify::sha256(&std::fs::read(zip)?);
    if sha256 != p.sha256 {
        return Err(ModError::VerifyFailed(format!(
            "{}: SHA-256 is {sha256}",
            p.tag
        )));
    }
    verify::attestation(
        &sha256,
        &std::fs::read(zip.with_extension("mod.json"))?,
        &p.repo,
    )?;
    let m = archive::inspect(zip)?;
    if (&m.id, &m.version, &m.abi, &m.deps) != (&p.id, &p.version, &p.abi, &p.deps) {
        return Err(ModError::VerifyFailed(format!(
            "{}: weft-mod.toml says {m:?}",
            p.tag
        )));
    }
    Ok(())
}
