import { CheckCircle2, CircleAlert, CircleDashed, CircleX, Clock3, LoaderCircle, PencilLine, ShieldCheck, ShieldAlert, SkipForward } from "lucide-react";
import { cn } from "../../lib/utils";

type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

const statusMap: Record<string, { label: string; tone: StatusTone; icon: typeof CircleDashed }> = {
  completed: { label: "已完成", tone: "success", icon: CheckCircle2 },
  approved: { label: "已批准", tone: "success", icon: ShieldCheck },
  running: { label: "运行中", tone: "info", icon: LoaderCircle },
  in_progress: { label: "运行中", tone: "info", icon: LoaderCircle },
  busy: { label: "处理中", tone: "info", icon: LoaderCircle },
  awaiting_approval: { label: "待审批", tone: "warning", icon: ShieldAlert },
  pending_gate: { label: "待审批", tone: "warning", icon: Clock3 },
  needs_revision: { label: "需修订", tone: "warning", icon: PencilLine },
  rejected: { label: "已驳回", tone: "danger", icon: CircleX },
  failed: { label: "失败", tone: "danger", icon: CircleAlert },
  error: { label: "错误", tone: "danger", icon: CircleAlert },
  skipped: { label: "已跳过", tone: "neutral", icon: SkipForward },
  pending: { label: "待执行", tone: "neutral", icon: CircleDashed },
  idle: { label: "待执行", tone: "neutral", icon: CircleDashed },
  ready: { label: "已生成", tone: "success", icon: CheckCircle2 },
  not_ready: { label: "待生成", tone: "neutral", icon: CircleDashed },
  foundation: { label: "Foundation", tone: "info", icon: CircleDashed },
  chapter_loop: { label: "章节创作", tone: "info", icon: CircleDashed },
  final_review: { label: "全书终审", tone: "warning", icon: ShieldAlert },
  "已生成": { label: "已生成", tone: "success", icon: CheckCircle2 },
  "已批准候选": { label: "已批准候选", tone: "success", icon: ShieldCheck },
  "待审批": { label: "待审批", tone: "warning", icon: Clock3 },
  "通过": { label: "通过", tone: "success", icon: CheckCircle2 },
  "需要重写": { label: "需修订", tone: "warning", icon: PencilLine },
  "建议发布": { label: "建议发布", tone: "success", icon: ShieldCheck },
  "需要修改": { label: "需修订", tone: "warning", icon: PencilLine },
};

const toneClasses: Record<StatusTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  info: "border-info/30 bg-info/10 text-info",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted/50 text-muted-foreground",
};

export function statusMeta(status: string | null | undefined) {
  return statusMap[status ?? ""] ?? { label: status || "未知", tone: "neutral" as const, icon: CircleDashed };
}

export function StatusBadge({ status, className, showIcon = true }: { status: string | null | undefined; className?: string; showIcon?: boolean }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0 text-xs font-semibold leading-none", toneClasses[meta.tone], className)}><Icon className={cn("size-3.5 shrink-0", (status === "running" || status === "in_progress" || status === "busy") && "animate-spin", !showIcon && "hidden")} aria-hidden="true" />{meta.label}</span>;
}

export function StatusIcon({ status, className }: { status: string | null | undefined; className?: string }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return <Icon className={cn("size-4", toneClasses[meta.tone].split(" ").find((item) => item.startsWith("text-")), (status === "running" || status === "in_progress" || status === "busy") && "animate-spin", className)} aria-hidden="true" />;
}
