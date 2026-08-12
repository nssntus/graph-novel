import { useEffect, useRef, useState } from "react";
import { Bot, FileText, Send } from "lucide-react";
import { api, type CreativeProjectDraft } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

type Message = { role: "user" | "assistant" | "error"; content: string };

export function ChatPanel({ projectId, onClose, onProjectDraft }: { projectId?: string; onClose: () => void; onProjectDraft?: (draft: CreativeProjectDraft) => void }) {
  const [messages, setMessages] = useState<Message[]>([]); const [value, setValue] = useState(""); const [busy, setBusy] = useState(false); const [draftBusy, setDraftBusy] = useState(false);
  const draftController = useRef<AbortController | null>(null); const closed = useRef(false);
  useEffect(() => () => { closed.current = true; draftController.current?.abort(); }, []);
  const validHistory = () => messages.filter((item): item is Message & { role: "user" | "assistant" } => item.role !== "error").slice(-20);
  async function send() {
    const message = value.trim(); if (!message || busy) return;
    const history = validHistory();
    setValue(""); setMessages((items) => [...items, { role: "user", content: message }]); setBusy(true);
    try { const response = await api<{ reply: string }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/chat` : "/api/creative/chat", { method: "POST", body: JSON.stringify({ message, history }) }); setMessages((items) => [...items, { role: "assistant", content: response.reply }]); }
    catch (error) { setMessages((items) => [...items, { role: "error", content: error instanceof Error ? error.message : "发送失败" }]); }
    finally { setBusy(false); }
  }
  async function makeDraft() {
    if (projectId || busy || draftBusy || !validHistory().some((message) => message.role === "user")) return;
    const controller = new AbortController(); draftController.current = controller; setDraftBusy(true);
    try {
      const response = await api<{ draft: CreativeProjectDraft }>("/api/creative/project-draft", { method: "POST", body: JSON.stringify({ history: validHistory() }), signal: controller.signal });
      if (!closed.current) onProjectDraft?.(response.draft);
    } catch (error) {
      if (!closed.current && !(error instanceof DOMException && error.name === "AbortError")) setMessages((items) => [...items, { role: "error", content: error instanceof Error ? error.message : "项目草案整理失败" }]);
    } finally { if (draftController.current === controller) draftController.current = undefined; setDraftBusy(false); }
  }
  function close() { closed.current = true; draftController.current?.abort(); onClose(); }
  const canDraft = !projectId && !busy && !draftBusy && validHistory().some((message) => message.role === "user");
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}><SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md"><SheetHeader className="border-b px-6 py-5"><SheetTitle className="flex items-center gap-2"><Bot />创意助手</SheetTitle><SheetDescription>{projectId ? "当前项目上下文已接入，可以讨论设定、因果和章节承接。" : "讨论题材、人物、情节因果和章节承接。"}</SheetDescription></SheetHeader><ScrollArea className="min-h-0 flex-1 px-6"><div className="flex flex-col gap-3 py-5 text-sm">{messages.length === 0 && <p className="text-muted-foreground">从一个创作问题开始。</p>}{messages.map((message, index) => <div key={`${index}-${message.role}`} className={message.role === "user" ? "ml-8 rounded-lg bg-primary p-3 text-primary-foreground" : message.role === "error" ? "rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive" : "rounded-lg bg-muted p-3"}>{message.content}</div>)}</div></ScrollArea><div className="border-t p-4"><div className="flex flex-col gap-2"><div className="flex items-center gap-2"><Input value={value} maxLength={2000} placeholder="输入你的想法…" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} disabled={busy || draftBusy} /><Button size="icon" aria-label="发送" onClick={() => void send()} disabled={busy || draftBusy || !value.trim()}><Send /></Button></div>{onProjectDraft && <Button variant="outline" className="w-full" onClick={() => void makeDraft()} disabled={!canDraft}><FileText data-icon="inline-start" />{draftBusy ? "正在整理项目草案…" : "整理为项目草案"}</Button>}</div></div></SheetContent></Sheet>;
}
