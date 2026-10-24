/** Only non-sensitive application behavior is written to piko.json. */
export const defaultPikoFile = {
  version: 1,
  agent: { profiles: {} },
  channels: { telegram: { enabled: false } },
  tools: { web_search: { enabled: true, providers: ["brave", "exa", "tavily", "deepseek"] }, web_extract: { enabled: true } },
};

/** Deployment defaults are never serialized into application JSON. */
export const defaultDeployment = { host: "127.0.0.1", port: 8787 };
