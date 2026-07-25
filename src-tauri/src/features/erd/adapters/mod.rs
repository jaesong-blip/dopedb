//! Concrete ERD authority, identity/time, and SQLite adapters.

mod authority;
mod repository;

pub(in crate::features::erd) use authority::ConnectionErdAuthority;
pub(in crate::features::erd) use repository::{SqliteErdRepository, SystemErdGenerator};
