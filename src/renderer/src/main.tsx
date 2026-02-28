import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { toast } from "sonner";
import { SyncStateProvider } from "./components/sync-state-provider";
import { createSyncStateStore } from "./services/state-sync-client";

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      onError: (error) => {
        toast.error(error.message || "An unexpected error occurred");
      },
    },
  },
});

createSyncStateStore()
  .then((syncState) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <SyncStateProvider store={syncState.store}>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </SyncStateProvider>
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error("Failed to bootstrap application:", error);
    const root = document.getElementById("root");
    if (root) {
      root.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;padding:24px;text-align:center">
          <p style="font-size:16px;font-weight:500">Failed to connect to backend</p>
          <p style="font-size:14px;color:oklch(0.72 0.01 260)">${escapeHtml(String(error))}</p>
          <button onclick="location.reload()" style="margin-top:8px;padding:6px 16px;border-radius:6px;background:oklch(0.24 0.01 260);cursor:pointer;border:1px solid oklch(0.34 0.01 260);color:inherit;font:inherit">
            Reload
          </button>
        </div>
      `;
    }
  });

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
