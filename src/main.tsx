// The polyfills MUST be imported first: they install `Buffer`/`global`/`process`
// before any Radiant library module body is evaluated.
import "./polyfills";

// Brand typeface, bundled locally so it works offline inside the WebView.
import "@fontsource-variable/inter";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element missing");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
