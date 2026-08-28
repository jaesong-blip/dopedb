// Owns BigQuery's local Google Cloud CLI authentication and bounded resource
// discovery. The editor receives only account and resource identifiers.
import { useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { errMessage } from "../../ipc/types";
import {
  BIGQUERY_AUTH_MODE_PARAMETER,
  bigQueryAuthMode,
  isValidBigQueryProjectId,
} from "./bigQueryOnboardingModel";
import type { BigQueryAuthMode, ConnectionProfile } from "./domain";
import {
  bigQueryAuthStateQuery,
  bigQueryDatasetsQuery,
  bigQueryProjectsQuery,
} from "./queries";
import {
  authenticateBigQueryGoogleAccount,
  authenticateBigQueryServiceAccount,
  clearBigQueryServiceAccountAuth,
  pickConnectionFile,
} from "./tauriAdapter";
import type { ConnectionProfileState } from "./useConnectionProfileState";

export function useBigQueryOnboardingController(
  profileState: ConnectionProfileState,
  cliAvailable: boolean,
) {
  const queryClient = useQueryClient();
  const createdServiceAccountProfile = useRef<ConnectionProfile | null>(null);
  const { form } = profileState;
  const profile = form.value;
  const mode = bigQueryAuthMode(profile);
  const applicable =
    profile.engine === "bigquery" && profile.workspaceAccess === "local";
  const enabled = applicable && cliAvailable;
  const auth = useQuery({
    ...bigQueryAuthStateQuery(profile),
    enabled,
  });
  const projects = useQuery({
    ...bigQueryProjectsQuery(profile),
    enabled: enabled && auth.data?.authenticated === true,
  });
  const projectId = profile.host.trim();
  const datasets = useQuery({
    ...bigQueryDatasetsQuery(profile, projectId),
    enabled:
      enabled &&
      auth.data?.authenticated === true &&
      isValidBigQueryProjectId(projectId),
  });

  async function refreshOnboarding() {
    await queryClient.invalidateQueries({
      queryKey: ["bigQueryOnboarding", profile.id],
    });
  }

  const googleAccount = useMutation({
    mutationFn: () => authenticateBigQueryGoogleAccount(profile),
    onSuccess: refreshOnboarding,
  });
  const serviceAccount = useMutation({
    mutationFn: async () => {
      const credentialFile = await pickConnectionFile();
      return credentialFile
        ? authenticateBigQueryServiceAccount(profile, credentialFile)
        : null;
    },
    onSuccess: async (result) => {
      if (result) {
        createdServiceAccountProfile.current = profile;
        await refreshOnboarding();
      }
    },
  });

  function setMode(nextMode: BigQueryAuthMode) {
    if (nextMode === mode) return;
    googleAccount.reset();
    serviceAccount.reset();
    form.setExtraParameter(
      BIGQUERY_AUTH_MODE_PARAMETER,
      nextMode === "serviceAccount" ? nextMode : "",
    );
  }

  function selectProject(nextProjectId: string) {
    form.setValue((current) => ({
      ...current,
      host: nextProjectId,
      database:
        current.host.trim() === nextProjectId.trim()
          ? current.database
          : "",
    }));
  }

  const error =
    googleAccount.error ??
    serviceAccount.error ??
    auth.error ??
    projects.error ??
    datasets.error;

  return {
    mode,
    enabled,
    auth: auth.data ?? null,
    projects: projects.data ?? [],
    datasets: datasets.data ?? [],
    pending:
      (enabled && auth.isPending) ||
      googleAccount.isPending ||
      serviceAccount.isPending,
    projectsPending: projects.isFetching,
    datasetsPending: datasets.isFetching,
    error: error ? errMessage(error) : null,
    setMode,
    selectProject,
    selectDataset: (datasetId: string) => form.set("database", datasetId),
    connectGoogleAccount: () => {
      if (enabled) googleAccount.mutate();
    },
    connectServiceAccount: () => {
      if (enabled) serviceAccount.mutate();
    },
    finalizeSavedProfile: async (saved: ConnectionProfile) => {
      const created = createdServiceAccountProfile.current;
      if (!created) return;
      if (
        saved.engine === "bigquery" &&
        bigQueryAuthMode(saved) === "serviceAccount"
      ) {
        createdServiceAccountProfile.current = null;
        return;
      }
      await clearBigQueryServiceAccountAuth(created);
      createdServiceAccountProfile.current = null;
    },
    discardUnpersistedAuth: async () => {
      const created = createdServiceAccountProfile.current;
      if (
        profileState.identity.persisted ||
        !created
      ) {
        return;
      }
      await clearBigQueryServiceAccountAuth(created);
      createdServiceAccountProfile.current = null;
    },
    refresh: () => void refreshOnboarding(),
  };
}

export type BigQueryOnboardingController = ReturnType<
  typeof useBigQueryOnboardingController
>;
