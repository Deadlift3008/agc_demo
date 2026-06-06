import { useEffect, useState } from "react";

// Статус сервиса векторизации: готова ли модель FRIDA и жива ли Chroma.
// Используется на обеих страницах полигона (/vector и /memory).
export interface Health {
  model: string;
  device?: string;
  model_ready: boolean;
  model_loading: boolean;
  model_error: string | null;
  dim: number | null;
  chroma_ok: boolean;
  chroma_error?: string;
  error?: string;
}

// Опрашивает /api/vector/health раз в 3 секунды, пока всё не станет зелёным.
// FRIDA при первом запуске скачивается и грузится несколько минут — без этого
// опроса пользователь жал бы кнопки в пустоту.
export function useEmbedderHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    async function poll() {
      let ok = false;
      try {
        const res = await fetch("/api/vector/health");
        const data = (await res.json()) as Health;
        if (stopped) return;
        setHealth(data);
        ok = Boolean(data.model_ready && data.chroma_ok);
      } catch {
        // backend ещё поднимается — просто попробуем ещё раз
      }
      if (!stopped && !ok) timer = window.setTimeout(poll, 3000);
    }

    poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return health;
}

export function EmbedderStatus({ health }: { health: Health | null }) {
  if (!health) return <div className="lab-warn">Проверяю эмбеддер…</div>;
  if (health.error) return <div className="db-error">{health.error}</div>;
  if (health.model_error)
    return <div className="db-error">Эмбеддер не загрузился: {health.model_error}</div>;
  if (!health.model_ready)
    return (
      <div className="lab-warn">
        ⏳ Модель {health.model} ещё грузится (первый запуск скачивает ~3 ГБ с
        Hugging Face — это нормально)…
      </div>
    );
  if (!health.chroma_ok)
    return <div className="db-error">Chroma недоступна: {health.chroma_error}</div>;
  return (
    <div className="db-sync">
      Эмбеддер <b>{health.model}</b> готов · размерность вектора {health.dim} ·
      Chroma ok
    </div>
  );
}
