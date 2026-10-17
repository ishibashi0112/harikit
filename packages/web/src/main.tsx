import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ishibashi0112/spreadsheet-grid/style.css";
import "./style.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
