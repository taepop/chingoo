MONOREPO_SETUP.md — Workspace Architecture
CRITICAL INSTRUCTION FOR AI AGENTS: This document defines the physical structure of the codebase. You must execute these steps to scaffold the project before writing any feature code. The architecture relies on pnpm workspaces to share Types (DTOs, Enums) and the Database Client between the Backend and Mobile apps.

1. Directory Structure (Target State)

The project must strictly follow this tree.

chingoo/
├── package.json          # Root configuration (scripts, devDependencies)
├── pnpm-workspace.yaml   # Defines workspace members
├── turbo.json            # Turborepo build pipeline config
├── tsconfig.base.json    # Base TS config extended by all apps
├── apps/
│   ├── api/              # NestJS v10 (Backend)
│   │   ├── src/
│   │   ├── package.json  # Depends on "@chingoo/shared"
│   │   └── tsconfig.json
│   └── mobile/           # Expo SDK 54 (Frontend) # Expo SDK 55 (Frontend)
│       ├── src/
│       ├── app.json
│       ├── metro.config.js # CRITICAL: Configured to watch packages/shared
│       ├── package.json    # Depends on "@chingoo/shared"
│       └── tsconfig.json
└── packages/
    └── shared/           # The "Glue" Package
        ├── prisma/
        │   └── schema.prisma # Single Source of Truth for DB Schema
        ├── src/
        │   ├── index.ts      # Exports everything
        │   ├── enums.ts      # Shared Enums (from API_CONTRACT.md)
        │   ├── dto/          # Shared DTOs (from API_CONTRACT.md)
        │   └── types/
        ├── package.json
        └── tsconfig.json


2. Initialization Script (Bash)
Use this script to scaffold the folders and initialize the monorepo logic.

# 1. Create Root Directory
mkdir chingoo && cd chingoo
pnpm init

# 2. Install Turbo and Root Deps
pnpm add turbo typescript -D -w

# 3. Create Folder Structure
mkdir -p apps/api apps/mobile
mkdir -p packages/shared/src/dto packages/shared/src/enums packages/shared/prisma

# 4. Create Workspace Config
touch pnpm-workspace.yaml turbo.json tsconfig.base.json

# 5. Initialize Shared Package
cd packages/shared
pnpm init
# (Manually edit package.json name to "@chingoo/shared" later)
cd ../..

3. Configuration Snippets
A. Root pnpm-workspace.yaml

Defines the boundaries of the monorepo.

packages:
  - "apps/*"
  - "packages/*"

B. Root package.json
Centralized scripts to run the whole stack.

{
  "name": "chingoo-monorepo",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "db:generate": "turbo run db:generate",
    "db:push": "turbo run db:push"
  },
  "devDependencies": {
    "turbo": "^1.12.0",
    "typescript": "^5.3.0",
    "prettier": "^3.0.0"
  },
  "packageManager": "pnpm@9.0.0"
}

C. Root tsconfig.base.json
Ensures all apps use strict typing.

{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}

4. The "Shared" Package Strategy (packages/shared)
This is the most critical component. It prevents code duplication and "hallucination" by ensuring the Backend and Frontend use the exact same Types.

4.1 packages/shared/package.json

{
  "name": "@chingoo/shared",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@prisma/client": "^5.10.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "prisma": "^5.10.0",
    "typescript": "^5.3.0"
  }
}

4.2 packages/shared/tsconfig.json
Must be a composite project to allow fast builds.

{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true
  },
  "include": ["src"]
}

4.3 packages/shared/src/index.ts
The entry point that exposes types to the apps.

// Export Enums
export * from './enums';

// Export DTOs
export * from './dto/onboarding.dto';
export * from './dto/chat.dto';
export * from './dto/auth.dto';
// ... export other DTOs defined in API_CONTRACT.md

// Re-export Prisma types (optional, if needed directly in frontend types)
// export * from '@prisma/client';

5. Connecting the Apps

A. Backend (apps/api)
1. Dependency: Add @chingoo/shared to package.json:

"dependencies": {
  "@chingoo/shared": "workspace:*",
  "@nestjs/common": "^10.0.0",
  ...
}

2. Usage: Import DTOs in controllers directly.
import { OnboardingRequestDto } from '@chingoo/shared';

B. Mobile (apps/mobile)
1. Dependency: Add @chingoo/shared to package.json:
"dependencies": {
  "@chingoo/shared": "workspace:*"
}

2. Metro Config (metro.config.js): CRITICAL: React Native's bundler does not support symlinks/monorepos out of the box. You MUST create this file in apps/mobile/.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the workspace root
const workspaceRoot = path.resolve(__dirname, '../..');
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);

// 1. Watch the workspace root to pick up changes in packages/shared
config.watchFolders = [workspaceRoot];

// 2. Let Metro resolve modules from the workspace root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Force Metro to resolve the shared package source
config.resolver.disableHierarchicalLookup = true;

module.exports = config;

6. Implementation Order for AI Agent
When scaffolding, follow this strict order:

1. Initialize Root: Create folders, pnpm-workspace.yaml, and package.json.

2. Scaffold Shared: Create packages/shared, paste SCHEMA.md content into packages/shared/prisma/schema.prisma, and create dummy DTO files. Run pnpm install.

3. Generate Client: Run pnpm prisma generate inside packages/shared.

4. Scaffold API: Initialize NestJS app in apps/api. Add workspace:* dependency.

5. Scaffold Mobile: Initialize Expo app in apps/mobile. Add workspace:* dependency. Create metro.config.js.

6. Verify: Run pnpm build at root to ensure packages/shared compiles and is visible to apps.

