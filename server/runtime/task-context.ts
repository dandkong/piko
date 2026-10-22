import { defineDoc } from "@earendil-works/pi-durable";

/** Association and cancellation provenance only; execution state remains native. */
export type TaskBinding = {
  /** Fixed persisted field, matching the task's items/<id> directory; not a second identity. */
  itemId: string;
  title: string;
  startedAt: number;
  scheduledAt: number | null;
  interrupted: boolean;
};
export const TaskContext = defineDoc<{ binding: TaskBinding | null }>({
  kind: "piko.item-context", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ binding: null }),
});
