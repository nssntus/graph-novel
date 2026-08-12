import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Textarea } from "../ui/textarea";

export function DecisionPanel({ label, path, disabled, onDone, reopen = false }: { label: string; path: string; disabled: boolean; onDone: () => void; reopen?: boolean }) {
  const [feedback, setFeedback] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(approved: boolean) {
    if (!approved && !feedback.trim()) { setError("驳回必须填写反馈。"); return; }
    setBusy(true); setError("");
    try { await api(path, { method: "POST", body: JSON.stringify(reopen ? { feedback } : { approved, feedback }) }); onDone(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); setBusy(false); }
  }
  return <Card className="mt-4 border-primary/30"><CardHeader><CardTitle className="text-base">{label}</CardTitle></CardHeader><CardContent className="space-y-2"><Textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={reopen ? "修订说明（必填）" : "审批反馈（驳回时必填）"} disabled={disabled || busy} />{error && <p className="text-sm text-destructive">{error}</p>}</CardContent><CardFooter className="gap-2">{reopen ? <Button onClick={() => void submit(true)} disabled={disabled || busy}><RotateCcw />重新进入审查</Button> : <><Button onClick={() => void submit(true)} disabled={disabled || busy}><Check />批准</Button><Button variant="destructive" onClick={() => void submit(false)} disabled={disabled || busy}>驳回并重写</Button></>}</CardFooter></Card>;
}
