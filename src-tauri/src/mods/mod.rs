//! The mod manager: a per-version mod set handed to the game with `--mods`, a signed index of
//! reviewed mods, GitHub repos as extra sources, and the checks between them and the game.
//! Design: `docs/mod-manager/PROPOSAL.md`; index contract: `docs/mod-manager/INDEX_FORMAT.md`.

pub mod abi;
pub mod archive;
pub mod catalog;
pub mod commands;
pub mod diagnose;
pub mod error;
pub mod index;
pub mod paths;
pub mod profile;
pub mod sources;
pub mod version;

pub use commands::prepare_launch;
