import { applyTheme, THEME_KEY } from "@bongsu/web/theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// this device's copy until the server's arrives (index.html applied it before the first paint)
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  applyTheme(null);
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
