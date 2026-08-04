import {
  useCallback,
  useReducer,
  type SetStateAction,
} from "react";

import type {
  GcpEnvironmentClassification,
  GcpSetupInstance,
  GcpSetupInventory,
  GcpSetupPermissionCheck,
  Integration,
  ManagedConnection,
  NeonBootstrapState,
  NeonConfiguration,
  NeonEnvironmentClassification,
  Provider,
  Resource,
  SharedConnection,
} from "./domain";
import { emptyNeon, emptyNeonBootstrap } from "./domain";

export type ProviderAccessState = {
  providers: Provider[];
  integrations: Integration[];
  connections: SharedConnection[];
  managedConnections: ManagedConnection[];
  selectedConnectionId: string;
  selectedIntegrationId: string;
  selection: Record<string, string>;
  resourceOptions: Record<string, Resource[]>;
  setupProviderId: string;
  neonConfiguration: NeonConfiguration;
  neonEnvironmentClassification: NeonEnvironmentClassification;
  neonBootstrap: NeonBootstrapState;
  neonPublicAclApproved: boolean;
  neonProductionApproved: boolean;
  gcpSetupInventory: GcpSetupInventory | null;
  gcpSetupInstances: GcpSetupInstance[];
  selectedGcpProjectId: string;
  selectedGcpInstanceId: string;
  gcpEnvironmentClassification: GcpEnvironmentClassification;
  gcpProductionApproved: boolean;
  gcpRestartApproved: boolean;
  gcpPermissionCheck: GcpSetupPermissionCheck | null;
  gcpIamRoleGrantApproved: boolean;
  gcpSetupError: string;
  gcpSetupReconnectRequired: boolean;
  loading: boolean;
  resourcePending: boolean;
  mutation: string;
  error: string;
};

type FieldUpdate = {
  [Key in keyof ProviderAccessState]: {
    type: "field";
    key: Key;
    update: SetStateAction<ProviderAccessState[Key]>;
  };
}[keyof ProviderAccessState];

export const initialProviderAccessState: ProviderAccessState = {
  providers: [],
  integrations: [],
  connections: [],
  managedConnections: [],
  selectedConnectionId: "",
  selectedIntegrationId: "",
  selection: {},
  resourceOptions: {},
  setupProviderId: "",
  neonConfiguration: emptyNeon,
  neonEnvironmentClassification: "",
  neonBootstrap: emptyNeonBootstrap,
  neonPublicAclApproved: false,
  neonProductionApproved: false,
  gcpSetupInventory: null,
  gcpSetupInstances: [],
  selectedGcpProjectId: "",
  selectedGcpInstanceId: "",
  gcpEnvironmentClassification: "",
  gcpProductionApproved: false,
  gcpRestartApproved: false,
  gcpPermissionCheck: null,
  gcpIamRoleGrantApproved: false,
  gcpSetupError: "",
  gcpSetupReconnectRequired: false,
  loading: true,
  resourcePending: false,
  mutation: "",
  error: "",
};

export function providerAccessReducer(
  state: ProviderAccessState,
  action: FieldUpdate,
): ProviderAccessState {
  const current = state[action.key];
  const next =
    typeof action.update === "function"
      ? (
          action.update as (
            value: typeof current,
          ) => typeof current
        )(current)
      : action.update;
  return { ...state, [action.key]: next };
}

export function useProviderAccessState() {
  const [state, dispatch] = useReducer(
    providerAccessReducer,
    initialProviderAccessState,
  );
  const setter = useCallback(
    <Key extends keyof ProviderAccessState>(key: Key) =>
      (update: SetStateAction<ProviderAccessState[Key]>) =>
        dispatch({ type: "field", key, update } as FieldUpdate),
    [],
  );
  return [state, setter] as const;
}
