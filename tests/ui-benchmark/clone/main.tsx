import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { referenceMetrics } from "./metrics";
import { ReferenceShell } from "./ReferenceShell";
import {
  isReferenceCloneSceneId,
  referenceCloneScenes,
} from "./scenes";
import "./referenceClone.css";

declare global {
  interface Window {
    __referenceCloneMetrics?: typeof referenceMetrics;
  }
}

const requested = new URLSearchParams(location.search).get("scene");
if (!isReferenceCloneSceneId(requested)) {
  throw new Error(`Unknown reference clone scene: ${requested ?? "<missing>"}`);
}

window.__referenceCloneMetrics = referenceMetrics;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReferenceShell scene={referenceCloneScenes[requested]} />
  </StrictMode>,
);

void document.fonts.ready.then(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.dataset.referenceCloneReady = "true";
    });
  });
});
