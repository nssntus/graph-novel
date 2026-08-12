export type ServiceStatus = "idle" | "running" | "awaiting_approval" | "failed" | "completed" | "busy";
export type ProjectState = Record<string, any> & {
  projectId: string;
  novelTitle: string;
  workflowPhase: string;
  pendingGate: string | null;
  foundationApproval: string;
  approvedChapters: Array<{ chapterNumber: number; title: string; summary?: string; polishedDraft?: string }>;
  targetTotalChapters: number;
  targetTotalWords: number;
  pendingChapterNumber: number | null;
  lastError: { nodeKey: string; message: string; attempt: number } | null;
  updatedAt: string;
  nodes: Record<string, { status: string; attempts: number; error?: string }>;
  executionEvents: Array<Record<string, any>>;
};
export type StateResponse = { state: ProjectState; status: ServiceStatus };
