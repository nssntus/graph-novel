export type ProjectSummary = { projectId: string; novelTitle: string; status: string };

export type CreativeProjectDraft = {
  novelTitle: string;
  creativeGenre: string;
  creativePremise: string;
  creativeTheme: string;
  creativeNotes: string;
  targetTotalChapters: number;
  targetTotalWords: number;
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let payload: unknown = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : `请求失败（${response.status}）`;
    throw new Error(error);
  }
  return payload as T;
}

export function projectPath(projectId: string, route = "overview"): string {
  return `/project/${encodeURIComponent(projectId)}/${route}`;
}

export function projectStatePath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/state`;
}

export function commandPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/commands/${suffix}`;
}

export function createProjectEventSource(projectId: string, onRefresh: () => void, onError: () => void): EventSource {
  const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(onRefresh, 120);
  };
  source.addEventListener("task", schedule);
  source.addEventListener("state", schedule);
  source.addEventListener("graph", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as { event?: { type?: string } };
      if (payload.event?.type === "agent_event") return;
    } catch { /* GET state remains the source of truth. */ }
    schedule();
  });
  source.onerror = onError;
  return source;
}
