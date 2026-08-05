import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { recordStartupMark } from "./features/runtime/tauriAdapter";
import { AppProviders } from "./lib/appProviders";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => {
    void recordStartupMark("first_shell_commit").catch(() => undefined);
  });
});
