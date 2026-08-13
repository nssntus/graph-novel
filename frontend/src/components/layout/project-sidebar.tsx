import { Download, FileText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Progress } from "../ui/progress";
import { StatusBadge } from "../status/status-badge";
import type { ProjectState, ServiceStatus } from "../../types/graph";

export function ProjectSidebar({ state, status }: { state: ProjectState; status: ServiceStatus; route?: string }) {
  const progress = Math.min(100, (state.approvedChapters.length / Math.max(1, state.targetTotalChapters)) * 100);
  return <aside className="flex flex-col gap-3 lg:sticky lg:top-24 lg:self-start">
    <Card>
      <CardHeader className="gap-2 p-4">
        <CardDescription>当前项目</CardDescription>
        <CardTitle className="break-words text-base leading-6">{state.novelTitle}</CardTitle>
        <code className="truncate text-xs text-muted-foreground">{state.projectId}</code>
        <div className="flex flex-wrap items-center gap-2 pt-1"><StatusBadge status={status} /></div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <Separator className="mb-4" />
        <div className="flex items-center justify-between text-xs"><span>章节进度</span><strong>{state.approvedChapters.length} / {state.targetTotalChapters}</strong></div>
        <Progress className="mt-2" value={progress} aria-label={`章节进度 ${Math.round(progress)}%`} />
      </CardContent>
    </Card>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
      <Button variant="outline" size="sm" asChild><a href={`/api/projects/${encodeURIComponent(state.projectId)}/export/novel`} download><FileText data-icon="inline-start" />下载正文</a></Button>
      <Button variant="outline" size="sm" asChild><a href={`/api/projects/${encodeURIComponent(state.projectId)}/export/state`} download><Download data-icon="inline-start" />导出状态</a></Button>
    </div>
  </aside>;
}
