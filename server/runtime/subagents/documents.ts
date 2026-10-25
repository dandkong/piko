import {
  defineDoc,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import type { InputSource } from "../types";

export const JobControl = defineDoc<{ epoch: number; reported: number[] }>({
  kind: "piko.subagent-control",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ epoch: 0, reported: [] }),
});
export const SubagentPromptScope = defineDoc<{ isSubagent: boolean }>({
  kind: "piko.subagent-prompt-scope",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ isSubagent: false }),
});
export const ANCHOR_KIND = "piko.subagent-anchor";
export const REPORTER_KIND = "piko.subagent-reporter";

export type ReporterInput = {
  child: ConversationId;
  message: string;
  epoch: number;
  source: InputSource;
};
export type ReporterState =
  | { phase: "deliver" }
  | { phase: "report"; answer?: EntryId; error?: string };
export type ReporterResult = { answer?: EntryId; error?: string } | null;
