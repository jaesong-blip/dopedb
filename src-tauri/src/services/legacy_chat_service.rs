//! Read-only access to conversations created by the retired in-app Agent chat.

use uuid::Uuid;

use crate::error::AppResult;
use crate::legacy_chat::{ChatMessageRecord, ChatThread};
use crate::store::Store;

#[derive(Clone)]
pub(crate) struct LegacyChatService {
    store: Store,
}

impl LegacyChatService {
    pub(super) fn new(store: Store) -> Self {
        Self { store }
    }

    pub(crate) async fn list_threads(&self) -> AppResult<Vec<ChatThread>> {
        self.store.list_chat_threads().await
    }

    pub(crate) async fn messages(&self, thread_id: Uuid) -> AppResult<Vec<ChatMessageRecord>> {
        self.store.list_chat_messages(thread_id).await
    }
}
