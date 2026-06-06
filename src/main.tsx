import React from "react";
import ReactDOM from "react-dom/client";
import "./theme.css";
import App from "./App";
import ApprovalView from "./ApprovalView";

// The dedicated approval window opens index.html?view=approval (see
// open_approval_window in src-tauri/src/lib.rs); everything else is the shell.
const isApproval = new URLSearchParams(window.location.search).get("view") === "approval";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isApproval ? <ApprovalView /> : <App />}</React.StrictMode>,
);
