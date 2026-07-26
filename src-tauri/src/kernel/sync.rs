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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::lock_unpoisoned;

    #[test]
    fn recovers_the_inner_value_after_a_mutex_is_poisoned() {
        let value = Arc::new(Mutex::new(0_u8));
        let worker_value = value.clone();
        let worker = std::thread::spawn(move || {
            *worker_value.lock().expect("fixture lock") = 7;
            panic!("poison fixture");
        });
        assert!(worker.join().is_err());

        assert_eq!(*lock_unpoisoned(&value), 7);
    }
}
