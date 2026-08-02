import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackStart(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 8105,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8105,
    strictPort: true,
  },
  ssr: {
    noExternal: ["@agent-native/core", "@agent-native/toolkit"],
  },
});
