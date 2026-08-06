import { Profiler, type ReactNode } from "react";
import { recordReactCommit } from "./packagedMetrics";

export function PackagedBenchmarkProfiler({ children }: { children: ReactNode }) {
  return (
    <Profiler id="dopedb-packaged-root" onRender={recordReactCommit}>
      {children}
    </Profiler>
  );
}
