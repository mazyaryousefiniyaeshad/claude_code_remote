export interface EventStream {
  close: () => void;
}

const SILENCE_MS = 40_000;

export function openEventStream(
  url: string,
  headers: Record<string, string>,
  onData: (data: string, id: number | null) => void,
  onError: (gone: boolean) => void,
): EventStream {
  const controller = new AbortController();
  let closed = false;
  let gone = false;
  let lastActivity = Date.now();

  const watchdog = window.setInterval(() => {
    if (Date.now() - lastActivity > SILENCE_MS) controller.abort();
  }, 5_000);

  const fail = () => {
    window.clearInterval(watchdog);
    if (!closed) onError(gone);
  };

  (async () => {
    const res = await fetch(url, {
      headers: { ...headers, Accept: "text/event-stream" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 404) gone = true;
    if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const lines = block.split("\n");
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        const idLine = lines.find((line) => line.startsWith("id:"));
        const id = idLine ? Number(idLine.slice(3).trim()) : null;
        if (data && !closed) onData(data, Number.isFinite(id) ? id : null);
        cut = buffer.indexOf("\n\n");
      }
    }
    fail();
  })().catch(fail);

  return {
    close: () => {
      closed = true;
      window.clearInterval(watchdog);
      controller.abort();
    },
  };
}
