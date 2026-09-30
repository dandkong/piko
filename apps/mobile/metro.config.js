const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repositoryRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

// Keep the shared chat contract/parser inside Metro's watched repository.
config.watchFolders = [...(config.watchFolders ?? []), repositoryRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repositoryRoot, "node_modules"),
];

module.exports = config;
