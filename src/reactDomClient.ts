type ReactDomClientModule = Pick<
  typeof import("react-dom/client"),
  "createRoot"
>;

const implementation = import.meta.env.VITE_DOPEDB_PACKAGED_BENCHMARK === "1"
  ? await import("react-dom/profiling") as ReactDomClientModule
  : await import("react-dom/client");

export const createRoot = implementation.createRoot;
