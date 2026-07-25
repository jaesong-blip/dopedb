//! System identity and clock adapter for Job use cases.

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::kernel::identity::{JobId, OperationId};

use super::super::ports::JobGeneratorPort;

const FILE_CAPABILITY_DAYS: i64 = 30;
const IMPORT_OPERATION_MINUTES: i64 = 30;

#[derive(Clone, Copy)]
pub(in crate::features::jobs) struct SystemJobGenerator;

impl JobGeneratorPort for SystemJobGenerator {
    fn next_job_id(&self) -> JobId {
        JobId::from(Uuid::new_v4())
    }

    fn next_operation_id(&self) -> OperationId {
        OperationId::from(Uuid::new_v4())
    }

    fn capability_expires_at(&self) -> DateTime<Utc> {
        Utc::now() + Duration::days(FILE_CAPABILITY_DAYS)
    }

    fn import_operation_expires_at(&self) -> DateTime<Utc> {
        Utc::now() + Duration::minutes(IMPORT_OPERATION_MINUTES)
    }
}
