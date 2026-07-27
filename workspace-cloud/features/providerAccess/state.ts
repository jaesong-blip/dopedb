import {
  useCallback,
  useReducer,
  type SetStateAction,
} from "react";

import type {
  GcpConfiguration,
  Integration,
  ManagedConnection,
  NeonConfiguration,
  Provider,
  Resource,
  SharedConnection,
} from "./domain";
import { emptyGcp, emptyNeon } from "./domain";

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
  gcpConfiguration: GcpConfiguration;
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
  gcpConfiguration: emptyGcp,
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
