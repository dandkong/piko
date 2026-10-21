/** Product contracts; native task/conversation IDs remain opaque strings. */
export type ItemSchedule = null | { type: "once"; at: string } | { type: "cron"; expression: string; timezone: string };
export type WorkItemDraft = { title: string; prompt: string; schedule: ItemSchedule; scheduleText?: string };
export type WorkItem = WorkItemDraft & {
  id: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  nextDueAt: number | null;
  latest?: ItemExecution;
};
export type ItemExecution = {
  id: string;
  startedAt: number;
  scheduledAt: number | null;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted";
  error?: string;
  preview?: string;
};
export type WorkItemDetail = { item: WorkItem; executions: ItemExecution[]; nextBefore?: string };
export type ItemExecutionDetail = { execution: ItemExecution; answer: string };
export type WorkItemCommand = { requestId: string } & (
  | { action: "create"; item: WorkItemDraft }
  | { action: "update"; id: string; item: WorkItemDraft }
  | { action: "status"; id: string; status: WorkItem["status"] }
  | { action: "run"; id: string }
  | { action: "stop"; id: string }
);
export type WorkItemReceipt = { id: string; executionId?: string; duplicate: boolean };
