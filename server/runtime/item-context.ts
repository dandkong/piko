import { defineDoc } from "@earendil-works/pi-durable";

/** Association and cancellation provenance only; execution state remains native. */
export type ItemBinding = {
  itemId: string;
  title: string;
  startedAt: number;
  scheduledAt: number | null;
  interrupted: boolean;
};
export const ItemContext = defineDoc<{ binding: ItemBinding | null }>({
  kind: "piko.item-context", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ binding: null }),
});
