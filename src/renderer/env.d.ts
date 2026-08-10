/// <reference types="vite/client" />

import type { KozumApi } from "../preload/index.ts";

declare global {
  interface Window {
    /** Injected by the preload bridge. Absent outside Electron. */
    kozum?: KozumApi;
  }
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
