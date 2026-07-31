import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async ({ command, mode }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // PublicNode's RPC key, for the browser-preview fetch fallback in src/lib/rpc.ts.
    // Dev server only: in the packaged app every read goes through the Rust
    // `node_rpc` command (which appends the key itself), so a production bundle has
    // no use for the key and shouldn't carry a copy of it.
    __PUBLIC_NODE_KEY__: JSON.stringify(
      // @ts-expect-error process is a nodejs global
      command === "serve" ? (loadEnv(mode, process.cwd(), "").PUBLIC_NODE_KEY ?? "") : "",
    ),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
