//! Provisioning execution, cancellation, and runtime recovery.

use super::*;

impl ProvisioningCoordinator {
    pub(crate) async fn execute(&self, receipt_id: Uuid) -> AppResult<ProvisioningReceipt> {
        let scope = self.repository.active_scope().await?;
        let receipt = self.receipts.load(&scope, receipt_id).await?;
        let operation = self.operations.get(receipt.operation_id()).await?;
        let (plan, driver) = validate_execution(&receipt, &operation, &self.drivers)?;
        let claimed = self.operations.claim(operation.id).await?;
        self.run_registered(scope, receipt, plan, claimed, driver)
            .await
    }

    pub(crate) async fn cancel(&self, receipt_id: Uuid) -> AppResult<()> {
        let cancellation = self
            .cancellations
            .lock()
            .await
            .get(&receipt_id)
            .cloned()
            .ok_or_else(|| blocked("provider provisioning is not running"))?;
        cancellation.cancel();
        Ok(())
    }

    pub(crate) async fn recover_previous_runtimes(
        &self,
        operation_ids: &[Uuid],
    ) -> AppResult<ProvisioningRecoveryReport> {
        let scope = self.repository.active_scope().await?;
        let mut report = ProvisioningRecoveryReport::default();
        for operation_id in operation_ids {
            let operation = self.operations.get(*operation_id).await?;
            let receipt = self
                .receipts
                .load_for_operation(&scope, *operation_id)
                .await;
            let validated = receipt
                .as_ref()
                .ok()
                .and_then(|receipt| validate_execution(receipt, &operation, &self.drivers).ok());
            let Some((plan, driver)) = validated else {
                if let Ok(mut receipt) = receipt {
                    self.mark_repair(
                        &scope,
                        &mut receipt,
                        ProvisioningRepairReason::ApplyOutcomeUnknown,
                    )
                    .await?;
                }
                self.operations
                    .quarantine_provider_execution(
                        *operation_id,
                        &operation.payload_hash,
                        "provisioning_checkpoint_rejected",
                    )
                    .await?;
                report.quarantined.push(*operation_id);
                continue;
            };
            let receipt = receipt.expect("validated receipt is present");
            let claimed = self
                .operations
                .resume_provider_claim(*operation_id, &operation.payload_hash)
                .await?;
            match self
                .run_registered(scope.clone(), receipt, plan, claimed, driver)
                .await
            {
                Ok(_) => report.resumed.push(*operation_id),
                Err(_) => report.quarantined.push(*operation_id),
            }
        }
        Ok(report)
    }

    async fn run_registered(
        &self,
        scope: ActiveResourceScope,
        receipt: ProvisioningReceipt,
        plan: ProvisioningPlan,
        claimed: ClaimedOperation,
        driver: Arc<dyn ProvisioningDriver>,
    ) -> AppResult<ProvisioningReceipt> {
        let receipt_id = receipt.id();
        let operation_id = claimed.record().id;
        let cancellation = CancellationToken::new();
        {
            use std::collections::hash_map::Entry;

            let mut running = self.cancellations.lock().await;
            match running.entry(receipt_id) {
                Entry::Vacant(entry) => {
                    entry.insert(cancellation.clone());
                }
                Entry::Occupied(_) => {
                    return Err(blocked("provider provisioning is already running"));
                }
            }
        }
        let result = self
            .run_claimed(
                &scope,
                receipt,
                &plan,
                &claimed,
                driver.as_ref(),
                &cancellation,
            )
            .await;
        self.cancellations.lock().await.remove(&receipt_id);
        if result.is_err()
            && self
                .operations
                .get(operation_id)
                .await
                .is_ok_and(|operation| operation.state == OperationState::Executing)
        {
            let _ = self
                .operations
                .mark_outcome_unknown(
                    operation_id,
                    &serde_json::json!({
                        "providerAuditId": plan.target().provider_audit_id(),
                        "reason": "provisioning_coordinator_aborted",
                        "receiptId": receipt_id,
                        "totalSteps": plan.steps().len(),
                    }),
                )
                .await;
        }
        result
    }

    async fn run_claimed(
        &self,
        scope: &ActiveResourceScope,
        mut receipt: ProvisioningReceipt,
        plan: &ProvisioningPlan,
        claimed: &ClaimedOperation,
        driver: &dyn ProvisioningDriver,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningReceipt> {
        let record = claimed.record();
        if claimed.grant().operation_id() != receipt.operation_id()
            || claimed.grant().payload_sha256() != receipt.plan_hash()
            || claimed.grant().connection_id() != Uuid::from(receipt.connection_id())
            || record.payload_hash != receipt.plan_hash()
        {
            return Err(blocked("provider provisioning execution grant is invalid"));
        }

        match plan.intent() {
            ProvisioningIntent::Apply => {
                if receipt.state() == ProvisioningState::ReadyToApply {
                    let expected = receipt.revision();
                    receipt.begin_apply(plan, record.id, Utc::now())?;
                    self.receipts.save(scope, &receipt, expected).await?;
                }
                if !matches!(
                    receipt.state(),
                    ProvisioningState::Applying | ProvisioningState::Verifying
                ) {
                    return Err(blocked("provider provisioning apply cannot resume"));
                }
                if receipt.state() == ProvisioningState::Applying {
                    for step in plan
                        .steps()
                        .iter()
                        .skip(usize::from(receipt.completed_steps()))
                    {
                        if cancellation.is_cancelled() {
                            return self.cancel_execution(scope, receipt, plan, record.id).await;
                        }
                        let permit = ProvisioningExecutionPermit::issue(
                            record.id,
                            receipt.provider(),
                            receipt.plan_hash().to_owned(),
                            step.execution_sha256().to_owned(),
                        );
                        let evidence =
                            match driver.execute_step(plan, step, &permit, cancellation).await {
                                Ok(evidence) if evidence.validates(step) => evidence,
                                Ok(_) | Err(_) => {
                                    return self
                                        .fail_execution(
                                            scope,
                                            receipt,
                                            plan,
                                            record.id,
                                            ProvisioningRepairReason::ApplyOutcomeUnknown,
                                            "provider_apply_outcome_unknown",
                                        )
                                        .await;
                                }
                            };
                        let expected = receipt.revision();
                        receipt.checkpoint(plan, evidence.sequence, Utc::now())?;
                        self.receipts.save(scope, &receipt, expected).await?;
                        self.operations
                            .progress(
                                record.id,
                                &serde_json::json!({
                                    "phase": "apply",
                                    "sequence": step.sequence(),
                                    "action": step.action(),
                                }),
                            )
                            .await?;
                    }
                    let expected = receipt.revision();
                    receipt.begin_verification(plan, Utc::now())?;
                    self.receipts.save(scope, &receipt, expected).await?;
                }
                if cancellation.is_cancelled() {
                    return self.cancel_execution(scope, receipt, plan, record.id).await;
                }
                let verification = match driver.verify(plan, cancellation).await {
                    Ok(verification) if verification_matches_plan(plan, &verification) => {
                        verification
                    }
                    Ok(_) | Err(_) => {
                        return self
                            .fail_execution(
                                scope,
                                receipt,
                                plan,
                                record.id,
                                ProvisioningRepairReason::VerificationFailed,
                                "provider_verification_failed",
                            )
                            .await;
                    }
                };
                let expected = receipt.revision();
                receipt.complete_verification(verification, Utc::now())?;
                self.receipts.save(scope, &receipt, expected).await?;
            }
            ProvisioningIntent::Destroy => {
                if receipt.state() != ProvisioningState::Destroying {
                    return Err(blocked("provider provisioning destroy cannot resume"));
                }
                for step in plan
                    .steps()
                    .iter()
                    .skip(usize::from(receipt.completed_steps()))
                {
                    if cancellation.is_cancelled() {
                        return self.cancel_execution(scope, receipt, plan, record.id).await;
                    }
                    let permit = ProvisioningExecutionPermit::issue(
                        record.id,
                        receipt.provider(),
                        receipt.plan_hash().to_owned(),
                        step.execution_sha256().to_owned(),
                    );
                    let evidence =
                        match driver.execute_step(plan, step, &permit, cancellation).await {
                            Ok(evidence) if evidence.validates(step) => evidence,
                            Ok(_) | Err(_) => {
                                return self
                                    .fail_execution(
                                        scope,
                                        receipt,
                                        plan,
                                        record.id,
                                        ProvisioningRepairReason::CleanupFailed,
                                        "provider_destroy_outcome_unknown",
                                    )
                                    .await;
                            }
                        };
                    let expected = receipt.revision();
                    receipt.checkpoint_destroy(plan, evidence.sequence, Utc::now())?;
                    self.receipts.save(scope, &receipt, expected).await?;
                }
                let expected = receipt.revision();
                receipt.finish_destroy(plan, Utc::now())?;
                self.receipts.save(scope, &receipt, expected).await?;
            }
        }
        self.operations
            .succeed(
                record.id,
                &serde_json::json!({
                    "completedSteps": plan.steps().len(),
                    "phase": receipt.phase(),
                    "providerAuditId": plan.target().provider_audit_id(),
                    "receiptId": receipt.id(),
                    "state": receipt.state(),
                    "totalSteps": plan.steps().len(),
                }),
            )
            .await?;
        Ok(receipt)
    }

    async fn cancel_execution(
        &self,
        scope: &ActiveResourceScope,
        mut receipt: ProvisioningReceipt,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
    ) -> AppResult<ProvisioningReceipt> {
        self.mark_repair(scope, &mut receipt, ProvisioningRepairReason::UserCancelled)
            .await?;
        self.operations
            .confirm_cancelled(
                operation_id,
                &serde_json::json!({
                    "completedSteps": receipt.completed_steps(),
                    "providerAuditId": plan.target().provider_audit_id(),
                    "reason": "user_cancelled",
                    "receiptId": receipt.id(),
                    "totalSteps": plan.steps().len(),
                }),
            )
            .await?;
        Err(blocked("provider provisioning was cancelled"))
    }

    async fn fail_execution(
        &self,
        scope: &ActiveResourceScope,
        mut receipt: ProvisioningReceipt,
        plan: &ProvisioningPlan,
        operation_id: Uuid,
        repair_reason: ProvisioningRepairReason,
        operation_reason: &'static str,
    ) -> AppResult<ProvisioningReceipt> {
        self.mark_repair(scope, &mut receipt, repair_reason).await?;
        self.operations
            .mark_outcome_unknown(
                operation_id,
                &serde_json::json!({
                    "completedSteps": receipt.completed_steps(),
                    "providerAuditId": plan.target().provider_audit_id(),
                    "reason": operation_reason,
                    "receiptId": receipt.id(),
                    "totalSteps": plan.steps().len(),
                }),
            )
            .await?;
        Err(blocked("provider provisioning needs repair"))
    }

    async fn mark_repair(
        &self,
        scope: &ActiveResourceScope,
        receipt: &mut ProvisioningReceipt,
        reason: ProvisioningRepairReason,
    ) -> AppResult<()> {
        let expected = receipt.revision();
        receipt.needs_repair(reason, Utc::now())?;
        self.receipts.save(scope, receipt, expected).await
    }
}
