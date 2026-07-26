//! SQLite adapter for scoped, read-only retired in-app chat archives.

use crate::error::AppResult;
use crate::kernel::identity::RetiredChatThreadId;
use crate::store::Store;

use super::super::domain::{RetiredChatArchiveMessage, RetiredChatArchiveThread};
use super::super::ports::RetiredChatArchivePort;

#[derive(Clone)]
pub(crate) struct SqliteRetiredChatArchive {
    store: Store,
}

impl SqliteRetiredChatArchive {
    pub(crate) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl RetiredChatArchivePort for SqliteRetiredChatArchive {
    async fn list_threads(&self) -> AppResult<Vec<RetiredChatArchiveThread>> {
        self.store.list_retired_chat_archive_threads().await
    }

    async fn list_messages(
        &self,
        thread_id: RetiredChatThreadId,
    ) -> AppResult<Vec<RetiredChatArchiveMessage>> {
        self.store
            .list_retired_chat_archive_messages(thread_id)
            .await
    }
}
