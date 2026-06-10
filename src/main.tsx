import React from "react";
import ReactDOM from "react-dom/client";
import "./theme.css";
import "./components.css";
import "./lib/theme"; // applies the saved light/dark/system theme before first paint
import App from "./App";
import ApprovalView from "./ApprovalView";
import ToastOverlayView from "./ToastOverlayView";
import MenuOverlayView from "./MenuOverlayView";

// The dedicated approval window opens index.html?view=approval (see
// open_approval_window in src-tauri/src/lib.rs); everything else is the shell.
const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "approval" ? (
      <ApprovalView />
    ) : view === "toast-overlay" ? (
      <ToastOverlayView />
    ) : view === "menu-overlay" ? (
      <MenuOverlayView />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
