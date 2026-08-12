import { useState } from "react";
import { Bot, Send } from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

type Message = { role: "user" | "assistant" | "error"; content: string };

export function ChatPanel({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]); const [value, setValue] = useState(""); const [busy, setBusy] = useState(false);
  async function send() {
    const message = value.trim(); if (!message || busy) return;
    const history = messages.filter((item): item is Message & { role: "user" | "assistant" } => item.role !== "error").slice(-20);
    setValue(""); setMessages((items) => [...items, { role: "user", content: message }]); setBusy(true);
    try { const response = await api<{ reply: string }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/chat` : "/api/creative/chat", { method: "POST", body: JSON.stringify({ message, history }) }); setMessages((items) => [...items, { role: "assistant", content: response.reply }]); }
    catch (error) { setMessages((items) => [...items, { role: "error", content: error instanceof Error ? error.message : "发送失败" }]); }
    finally { setBusy(false); }
  }
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md"><SheetHeader className="border-b px-6 py-5"><SheetTitle className="flex items-center gap-2"><Bot />创意助手</SheetTitle><SheetDescription>{projectId ? "当前项目上下文已接入，可以讨论设定、因果和章节承接。" : "讨论题材、人物、情节因果和章节承接。"}</SheetDescription></SheetHeader><ScrollArea className="min-h-0 flex-1 px-6"><div className="flex flex-col gap-3 py-5 text-sm">{messages.length === 0 && <p className="text-muted-foreground">从一个创作问题开始。</p>}{messages.map((message, index) => <div key={`${index}-${message.role}`} className={message.role === "user" ? "ml-8 rounded-lg bg-primary p-3 text-primary-foreground" : message.role === "error" ? "rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive" : "rounded-lg bg-muted p-3"}>{message.content}</div>)}</div></ScrollArea><div className="border-t p-4"><div className="flex items-center gap-2"><Input value={value} maxLength={2000} placeholder="输入你的想法…" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} disabled={busy} /><Button size="icon" aria-label="发送" onClick={() => void send()} disabled={busy || !value.trim()}><Send /></Button></div></div></SheetContent></Sheet>;
}
