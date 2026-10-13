export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelSelection = { provider: string; model: string; thinking?: ThinkingLevel };
export type RuntimeSelection = { profile: string } | ModelSelection | { thinking: ThinkingLevel };
export type CompactionResult = { status: "compacted" } | { status: "cancelled" } | { status: "skipped"; reason: "no_summary" | "stale" };
export type RuntimeDescription = {
  runtime: "pi-durable";
  tools: { name: string; status: "available" | "unconfigured" }[];
  selection?: ModelSelection;
  models: { provider: string; id: string; name: string; imageInput: boolean; contextWindow?: number; thinkingLevels: ThinkingLevel[] }[];
  profiles: Record<string, ModelSelection>;
  skills: { name: string; description: string; path: string; disableModelInvocation: boolean }[];
};
