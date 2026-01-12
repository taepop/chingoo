// metro.config.js
// Per MONOREPO_SETUP.md: Configure Metro for monorepo workspace resolution

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project and workspace directories
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const sharedPackagePath = path.resolve(monorepoRoot, 'packages/shared');

const config = getDefaultConfig(projectRoot);

// Add the shared package to watch folders (keep Expo defaults)
config.watchFolders = [
  ...(config.watchFolders || []),
  sharedPackagePath,
];

// Let Metro know where to resolve packages in monorepo
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Exclude backend code from bundling
config.resolver.blockList = [
  ...(config.resolver.blockList || []),
  /.*\/apps\/api\/.*/,
];

module.exports = config;
