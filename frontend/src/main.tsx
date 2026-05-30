import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DbViewer from "./DbViewer";
import "./styles.css";

// Минимальный роутинг по pathname без зависимости от react-router:
// /db — смотрелка БД, всё остальное — чат.
const Page = window.location.pathname.startsWith("/db") ? DbViewer : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
