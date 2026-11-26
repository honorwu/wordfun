import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: { manualChunks: { pinyin: ["pinyin-pro"] } },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:5174",
    },
  },
});
