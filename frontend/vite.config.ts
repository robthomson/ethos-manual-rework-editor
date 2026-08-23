import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      // Matches backend/server.ts's default PORT (4100) — see that
      // file's header comment for why this has to be same-origin (via
      // this proxy) in dev for session cookies to work at all.
      "/api": {
        target: "http://localhost:4100",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
