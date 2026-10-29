import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Viewer only. The CLI (cli/) is never bundled; eslint forbids viewer imports of cli/.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
});
