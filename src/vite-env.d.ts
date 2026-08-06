/// <reference types="vite/client" />

declare module "*.css";

declare module "react-dom/profiling" {
  export { createRoot } from "react-dom/client";
}
