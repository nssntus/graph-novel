import { useEffect, useState } from "react";
import { ChatPanel } from "./components/chat/chat-panel";
import { ProjectLibrary } from "./pages/project-library";
import { ProjectWorkspace } from "./pages/project-workspace";
import { ReaderPage } from "./app";

type LocationState = { path: string; projectId: string | null; route: string };
function locationState(): LocationState {
  const match = window.location.pathname.match(/^\/project\/([^/]+)(?:\/(.*))?$/);
  return { path: window.location.pathname, projectId: match ? decodeURIComponent(match[1]) : null, route: match?.[2] || "overview" };
}

export function AppRoot() {
  const [location, setLocation] = useState(locationState); const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => { const onPop = () => setLocation(locationState()); window.addEventListener("popstate", onPop); return () => window.removeEventListener("popstate", onPop); }, []);
  useEffect(() => { const onClick = (event: MouseEvent) => { const target = event.target as HTMLElement; const link = target.closest("a"); if (!link || !link.href || new URL(link.href).origin !== window.location.origin || link.target === "_blank" || link.hasAttribute("download") || link.getAttribute("href")?.startsWith("/api/")) return; event.preventDefault(); window.history.pushState({}, "", link.href); setLocation(locationState()); }; document.addEventListener("click", onClick); return () => document.removeEventListener("click", onClick); }, []);
  if (location.path === "/reader") return <ReaderPage />;
  if (location.projectId) return <ProjectWorkspace projectId={location.projectId} initialRoute={location.route} onChat={(open) => setChatOpen(open)} />;
  return <><ProjectLibrary onChat={() => setChatOpen(true)} />{chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}</>;
}
