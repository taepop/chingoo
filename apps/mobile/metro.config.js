// metro.config.js
// CRITICAL: Configured to watch packages/shared and resolve workspace dependencies
// Per MONOREPO_SETUP.md: React Native's bundler does not support symlinks/monorepos out of the box

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project and workspace directories
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch all files in the monorepo
config.watchFolders = [monorepoRoot];

// Let Metro know where to resolve packages
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Disable hierarchical lookup to ensure workspace packages are resolved correctly
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
