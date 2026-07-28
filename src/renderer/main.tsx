import React from "react";
import { createRoot } from "react-dom/client";

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
