import { useEffect, useReducer } from "react";

import { errMessage } from "../../ipc/types";
import { getTableDdl } from "./tauriAdapter";

type DdlState = {
  text: string | null;
  error: string | null;
  copied: boolean;
};

type DdlAction =
  | { type: "loading" }
  | { type: "loaded"; text: string }
  | { type: "failed"; message: string }
  | { type: "copied"; copied: boolean };

const initialState: DdlState = {
  text: null,
  error: null,
  copied: false,
};

function reducer(state: DdlState, action: DdlAction): DdlState {
  switch (action.type) {
    case "loading":
      return initialState;
    case "loaded":
      return { text: action.text, error: null, copied: false };
    case "failed":
      return { text: null, error: action.message, copied: false };
    case "copied":
      return { ...state, copied: action.copied };
  }
}

export function useTableDdl(
  connectionId: string,
  table: string,
  schema?: string | null,
) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let active = true;
    dispatch({ type: "loading" });
    getTableDdl(connectionId, table, schema)
      .then((text) => active && dispatch({ type: "loaded", text }))
      .catch(
        (cause) =>
          active &&
          dispatch({ type: "failed", message: errMessage(cause) }),
      );
    return () => {
      active = false;
    };
  }, [connectionId, schema, table]);

  return {
    ...state,
    copy: async () => {
      if (!state.text) return;
      await navigator.clipboard.writeText(state.text);
      dispatch({ type: "copied", copied: true });
      window.setTimeout(
        () => dispatch({ type: "copied", copied: false }),
        1_500,
      );
    },
  };
}
