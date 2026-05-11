import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "docs",
    emptyOutDir: false,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5174,
  },
});
