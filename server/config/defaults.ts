/** Written only when piko.json is missing; environment overrides are never persisted. */
export const defaultPikoFile = {
  http: { host: "127.0.0.1", port: 8787, corsOrigins: [] as string[] },
  channels: { telegram: { enabled: false } },
};
