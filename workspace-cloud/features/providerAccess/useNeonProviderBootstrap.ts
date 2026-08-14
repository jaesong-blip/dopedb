"use client";

// Neon bootstrap owns classification, preflight, approval, and idempotent apply orchestration.
import { useCallback, useRef } from "react";

import {
  emptyNeonBootstrap,
  parseNeonBootstrapApply,
  parseNeonBootstrapPreflight,
  type Integration,
  type Provider,
} from "./domain";
import type { ProviderAccessFieldSetter, ProviderAccessState } from "./state";
import { providerResponseError } from "./transport";
import type { WorkspaceLocale } from "../../lib/workspace-locale";
import { workspaceMessages } from "../../lib/workspace-messages";

type ProviderAccessCopy = (typeof workspaceMessages)[WorkspaceLocale]["providerAccess"];

export function useNeonProviderBootstrap({
  workspaceId,
  locale,
  copy,
  state,
  setField,
  selectedProvider,
  selectedIntegration,
  clearPendingImport,
}: {
  workspaceId: string;
  locale: WorkspaceLocale;
  copy: ProviderAccessCopy;
  state: ProviderAccessState;
  setField: ProviderAccessFieldSetter;
  selectedProvider: Provider | null;
  selectedIntegration: Integration | null;
  clearPendingImport: () => void;
}) {
  const {
    selection,
    resourceOptions,
    neonEnvironmentClassification,
    neonBootstrap,
    neonPublicAclApproved,
    neonProductionApproved,
    mutation,
  } = state;
  const setNeonEnvironmentClassification = setField("neonEnvironmentClassification");
  const setNeonBootstrap = setField("neonBootstrap");
  const setNeonPublicAclApproved = setField("neonPublicAclApproved");
  const setNeonProductionApproved = setField("neonProductionApproved");
  const setMutation = setField("mutation");
  const setError = setField("error");
  const pendingApplyRef = useRef<{
    integrationId: string;
    planHash: string;
    body: string;
  } | null>(null);

  const resetNeonBootstrap = useCallback(() => {
    pendingApplyRef.current = null;
    setNeonEnvironmentClassification("");
    setNeonBootstrap(emptyNeonBootstrap);
    setNeonPublicAclApproved(false);
    setNeonProductionApproved(false);
  }, [
    setNeonBootstrap,
    setNeonEnvironmentClassification,
    setNeonProductionApproved,
    setNeonPublicAclApproved,
  ]);

  function selectedNeonEnvironment() {
    if (selectedProvider?.id !== "neon") return null;
    const branchLevel = selectedProvider.resourceLevels.find((level) => level.kind === "branches");
    const branch = branchLevel
      ? resourceOptions[branchLevel.key]?.find((item) => item.value === selection[branchLevel.key])
      : null;
    if (branch?.production === true) return "production" as const;
    if (branch?.production === false) return "development" as const;
    return neonEnvironmentClassification || null;
  }

  function classifyNeonEnvironment(value: "" | "development" | "production") {
    clearPendingImport();
    pendingApplyRef.current = null;
    setNeonEnvironmentClassification(value);
    setNeonBootstrap(emptyNeonBootstrap);
    setNeonPublicAclApproved(false);
    setNeonProductionApproved(false);
    setError("");
  }

  async function preflightNeonBootstrap() {
    if (selectedProvider?.id !== "neon" || !selectedIntegration || mutation) return;
    const finalLevel = selectedProvider.resourceLevels.at(-1)!;
    const finalResource = resourceOptions[finalLevel.key]?.find(
      (item) => item.value === selection[finalLevel.key],
    );
    const environment = selectedNeonEnvironment();
    if (!finalResource?.selectionProof || finalResource.ready !== true) {
      setError(copy.neonReselect);
      return;
    }
    if (!environment) {
      setError(copy.neonClassify);
      return;
    }
    setMutation("neon:preflight");
    setError("");
    pendingApplyRef.current = null;
    setNeonBootstrap(emptyNeonBootstrap);
    setNeonPublicAclApproved(false);
    setNeonProductionApproved(false);
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${selectedIntegration.id}/neon-bootstrap`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "preflight",
            selectionProof: finalResource.selectionProof,
            environment,
          }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await providerResponseError(response, copy.neonPreflightError, locale));
        return;
      }
      const parsed = parseNeonBootstrapPreflight(await response.json().catch(() => null));
      const projectLevel = selectedProvider.resourceLevels.find((level) => level.kind === "projects");
      const branchLevel = selectedProvider.resourceLevels.find((level) => level.kind === "branches");
      if (
        !parsed
        || !projectLevel
        || !branchLevel
        || parsed.report.target.project !== selection[projectLevel.key]
        || parsed.report.target.branch !== selection[branchLevel.key]
        || parsed.report.target.databaseId !== finalResource.id
      ) {
        setError(copy.neonPreflightShapeError);
        return;
      }
      setNeonBootstrap({ ...parsed, receipt: "", receiptExpiresAt: "" });
    } finally {
      setMutation("");
    }
  }

  async function applyNeonBootstrap() {
    if (
      selectedProvider?.id !== "neon"
      || !selectedIntegration
      || !neonBootstrap.report
      || !neonBootstrap.plan
      || mutation
    ) return;
    if (Date.parse(neonBootstrap.planExpiresAt) <= Date.now()) {
      setNeonBootstrap(emptyNeonBootstrap);
      setNeonPublicAclApproved(false);
      setNeonProductionApproved(false);
      setError(copy.neonPreflightExpired);
      return;
    }
    if (neonBootstrap.report.status === "blocked") {
      setError(copy.neonBlocked);
      return;
    }
    if (neonBootstrap.report.requiresPublicAclApproval && !neonPublicAclApproved) {
      setError(copy.neonPublicApproval);
      return;
    }
    if (neonBootstrap.report.requiresProductionApproval && !neonProductionApproved) {
      setError(copy.neonProductionApproval);
      return;
    }
    setMutation("neon:apply");
    setError("");
    try {
      let pending = pendingApplyRef.current;
      if (
        !pending
        || pending.integrationId !== selectedIntegration.id
        || pending.planHash !== neonBootstrap.report.planHash
      ) {
        pending = {
          integrationId: selectedIntegration.id,
          planHash: neonBootstrap.report.planHash,
          body: JSON.stringify({
            action: "apply",
            plan: neonBootstrap.plan,
            idempotencyKey: crypto.randomUUID(),
            publicAclApproved: neonPublicAclApproved,
            productionApproved: neonProductionApproved,
          }),
        };
        pendingApplyRef.current = pending;
      }
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${selectedIntegration.id}/neon-bootstrap`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: pending.body,
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await providerResponseError(response, copy.neonApplyError, locale));
        return;
      }
      const parsed = parseNeonBootstrapApply(await response.json().catch(() => null));
      if (
        !parsed
        || parsed.report.planHash !== neonBootstrap.report.planHash
        || parsed.report.target.project !== neonBootstrap.report.target.project
        || parsed.report.target.branch !== neonBootstrap.report.target.branch
        || parsed.report.target.databaseId !== neonBootstrap.report.target.databaseId
      ) {
        setError(copy.neonApplyShapeError);
        return;
      }
      setNeonBootstrap((current) => ({
        ...current,
        report: parsed.report,
        receipt: parsed.receipt,
        receiptExpiresAt: parsed.receiptExpiresAt,
      }));
      pendingApplyRef.current = null;
    } finally {
      setMutation("");
    }
  }

  return {
    applyNeonBootstrap,
    classifyNeonEnvironment,
    preflightNeonBootstrap,
    resetNeonBootstrap,
  };
}
