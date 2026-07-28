// 하네스 진입점. 실제 src/App.tsx와 실제 provider 조합만 렌더한다.
// 별도 shell markup을 만들지 않으며, mock 설치 뒤에 App을 dynamic import한다.
import { createRoot } from "react-dom/client";
import { installMockRuntime } from "../runtime/installMockRuntime";
import { markSceneReady } from "../runtime/readiness";
import { getScenarioFromLocation } from "../scenarios";

const scenario = getScenarioFromLocation(window.location);
const router = installMockRuntime(scenario);

// import 시점에 Tauri나 plugin에 접근하는 모듈도 mock 경계 안에 두기 위해
// 반드시 installMockRuntime 이후에 불러온다.
const [{ default: App }, { AppProviders }] = await Promise.all([
  import("../../../src/App"),
  import("../../../src/lib/appProviders"),
]);

const container = document.getElementById("root");
if (!container) throw new Error("[ui-harness] #root is missing");

// StrictMode는 dev 전용 이중 호출을 유발해 IPC call log 계약을 흐리므로 쓰지 않는다.
createRoot(container).render(
  <AppProviders>
    <App />
  </AppProviders>,
);

void markSceneReady(router);
