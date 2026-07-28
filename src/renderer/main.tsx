import React from "react";
import { createRoot } from "react-dom/client";

import "./styles/global.css";
import { App } from "./App.tsx";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
