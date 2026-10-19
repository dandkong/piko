/** Product contracts; native task/conversation IDs remain opaque strings. */
export type ItemSchedule = null | { type: "once"; at: number } | { type: "cron"; expression: string; timezone: string };
export type WorkItemDraft = { title: string; prompt: string; schedule: ItemSchedule; scheduleText?: string };
export type WorkItem = WorkItemDraft & {
  id: string;
  status: "active" | "archived";
  revision: number;
  createdAt: number;
  updatedAt: number;
  nextDueAt: number | null;
  /** Internal: set once a finished one-off has been archived, so restore does not archive it again. */
  autoArchived?: boolean;
  latest?: ItemExecution;
};
export type ItemExecution = {
  id: string;
  startedAt: number;
  scheduledAt: number | null;
  revision: number;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted";
  error?: string;
  preview?: string;
};
export type WorkItemDetail = { item: WorkItem; executions: ItemExecution[]; nextBefore?: string };
export type ItemExecutionDetail = { execution: ItemExecution; answer: string };
export type WorkItemCommand = { requestId: string } & (
  | { action: "create"; item: WorkItemDraft }
  | { action: "update"; id: string; revision: number; item: WorkItemDraft }
  | { action: "status"; id: string; revision: number; status: WorkItem["status"] }
  | { action: "run"; id: string }
  | { action: "stop"; id: string; executionId: string }
);
export type WorkItemReceipt = { id: string; executionId?: string; duplicate: boolean };
