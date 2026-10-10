export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelSelection = { provider: string; model: string; thinking?: ThinkingLevel };
export type RuntimeSelection = { profile: string } | ModelSelection | { thinking: ThinkingLevel };
export type RuntimeDescription = {
  runtime: "pi-durable";
  selection?: ModelSelection;
  models: { provider: string; id: string; name: string; imageInput: boolean; contextWindow?: number; thinkingLevels: ThinkingLevel[] }[];
  profiles: Record<string, ModelSelection>;
  skills: { name: string; description: string; path: string; disableModelInvocation: boolean }[];
  plugins: { name: string; path: string; tools: string[] }[];
};
