import React from "react";
import ReactDOM from "react-dom/client";
import "./theme.css";
import "./components.css";
import "./lib/theme"; // applies the saved light/dark/system theme before first paint
import App from "./App";
import ApprovalView from "./ApprovalView";
import ToastOverlayView from "./ToastOverlayView";
import MenuOverlayView from "./MenuOverlayView";
// Last on purpose: the page stylesheets come in through the view imports above,
// and most of the motion layer targets the same single class names they do
// (.nav-item, .hero-eye, .acct-opt …). Imported any earlier it loses every one
// of those ties and the motion silently disappears.
import "./transitions.css";

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
