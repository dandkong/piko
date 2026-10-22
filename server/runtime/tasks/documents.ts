import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { AssistantTask } from "../../../shared/tasks";
import type { InputSource } from "../types";

export type StoredTask = Omit<AssistantTask, "latest"> & {
  source: InputSource;
};
/** once.at is an ISO 8601 instant; the stored shape has no older variant to migrate. */
export const TaskDefinitions = defineDoc<{ items: StoredTask[] }>({
  // Preserve this native kind and payload key; they are durable storage identities, not public names.
  kind: "piko.work-items",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
});
export const Receipts = defineDocFamily<
  { hash: string; id: string; executionId: string | null },
  null
>({
  kind: "piko.item-command",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ hash: "", id: "", executionId: null }),
});
