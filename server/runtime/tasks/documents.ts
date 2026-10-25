import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { AssistantTask } from "../../../shared/tasks";
import type { InputSource } from "../types";

export type StoredTask = Omit<AssistantTask, "latest"> & {
  source: InputSource;
};
/** once.at is an ISO 8601 instant. */
export const TaskDefinitions = defineDoc<{ tasks: StoredTask[] }>({
  kind: "piko.tasks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ tasks: [] }),
});
export const Receipts = defineDocFamily<
  { hash: string; id: string; executionId: string | null },
  null
>({
  kind: "piko.task-command",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ hash: "", id: "", executionId: null }),
});
