import React from "react";
import { createRoot } from "react-dom/client";

// Import the mock bridge FIRST so window.kozum exists before App boots.
// In Electron this is a no-op (the preload script already set window.kozum);
// in a browser preview it injects stub implementations.
import "./mock-bridge.ts";

import "./styles/global.css";
import { App } from "./App.tsx";

// ── Bootstrap: apply the persisted theme before React mounts ──────────────
// This prevents a flash of the wrong theme. We read the stored setting
// synchronously (if available) and set data-theme on <html> immediately.
// The Settings component will keep it in sync thereafter via useTheme.

(function bootstrapTheme() {
  const root = document.documentElement;
  // Default to dark until settings load.
  root.dataset.theme = "dark";
  root.dataset.motion = "system";
  root.dataset.font = "sans";
})();

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
