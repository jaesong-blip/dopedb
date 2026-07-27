//! Explicit provider-binding revocation fences for runtime cache leases.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::{
    cached_provider_context_from_authorization, cached_provider_fixture, CacheAuthority,
    CacheProviderLocal, ConnectionAccess, ConnectionContext,
};

#[tokio::test]
async fn provider_binding_tombstone_force_fences_an_active_cache_lease() {
    let authority = Arc::new(CacheAuthority::new());
    let local = Arc::new(CacheProviderLocal::new());
    let (manager, pinned, authorization, pool) =
        cached_provider_fixture(Arc::clone(&authority), Arc::clone(&local)).await;
    let binding_id = authorization
        .provider_local_pin
        .as_ref()
        .expect("fixture carries a provider binding")
        .binding_id;
    let provider_binding_fence_epoch = manager.provider_binding_fence_epoch();
    let lease = ConnectionContext {
        manager: manager.clone(),
        pin: pinned,
        access: ConnectionAccess::Read,
        authorization,
        provider_binding_fence_epoch,
        scope_guard: Some(Arc::clone(&manager.inner.scope_gate).read_owned().await),
    }
    .connect()
    .await
    .expect("fixture cache hands off a valid lease");

    manager.force_fence_provider_binding(binding_id).await;

    assert!(
        pool.is_closed(),
        "force fence closes despite an active lease"
    );
    assert!(lease.entry.closed.load(Ordering::Acquire));
    let slots = manager
        .inner
        .slots
        .iter()
        .map(|slot| Arc::clone(slot.value()))
        .collect::<Vec<_>>();
    for slot in slots {
        assert!(slot.lock().await.entry.is_none());
    }
}

#[tokio::test]
async fn force_fence_wins_a_cache_handoff_race_before_a_stale_lease_escapes() {
    let authority = Arc::new(CacheAuthority::new());
    let local = Arc::new(CacheProviderLocal::new());
    let (manager, pinned, authorization, pool) =
        cached_provider_fixture(Arc::clone(&authority), Arc::clone(&local)).await;
    let binding_id = authorization
        .provider_local_pin
        .as_ref()
        .expect("fixture carries a provider binding")
        .binding_id;
    let context =
        cached_provider_context_from_authorization(manager.clone(), pinned, authorization).await;
    let race = local.begin_cache_hit_race();
    let started = race.a_reauthorization_started.notified();
    let caller = tokio::spawn(async move { context.connect().await });
    started.await;

    manager.force_fence_provider_binding(binding_id).await;
    assert!(
        pool.is_closed(),
        "fence closes the cached pool before handoff resumes"
    );
    race.resume_a_with_old_authorization.notify_waiters();

    assert!(matches!(
        caller.await.expect("cache caller joins"),
        Err(crate::error::AppError::Blocked { .. })
    ));
    assert_eq!(local.resolve_calls.load(Ordering::SeqCst), 1);
}
