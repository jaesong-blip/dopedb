//! Poison-tolerant synchronization primitives shared by long-lived runtimes.

use std::sync::{Mutex, MutexGuard};

/// Acquire a standard mutex and retain its inner state after another thread panics.
///
/// The protected registries use atomic critical sections and remain preferable to
/// cascading process-wide panics after a worker failure. Callers still own any
/// domain-level repair required for the protected value.
pub(crate) fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
