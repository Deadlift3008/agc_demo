import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Прокидываем /api на backend-контейнер — так в браузере нет CORS,
      // а фронт ходит по относительному пути. Стриминг http-proxy держит.
      "/api": {
        target: "http://backend:8080",
        changeOrigin: true,
      },
    },
  },
});
