import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DbViewer from "./DbViewer";
import VectorLab from "./VectorLab";
import MemoryLab from "./MemoryLab";
import "./styles.css";

// Минимальный роутинг по pathname без зависимости от react-router:
// /db — просмотр БД, /vector — векторизация Postgres → Chroma,
// /memory — retrieve из Chroma, всё остальное — чат.
const path = window.location.pathname;
const Page = path.startsWith("/db")
  ? DbViewer
  : path.startsWith("/vector")
    ? VectorLab
    : path.startsWith("/memory")
      ? MemoryLab
      : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
