MONOREPO_SETUP.md — Workspace Architecture
CRITICAL INSTRUCTION FOR AI AGENTS: This document defines the physical structure of the codebase. You must execute these steps to scaffold the project before writing any feature code. The architecture relies on pnpm workspaces to share Types (DTOs, Enums) and the Database Client between the Backend and Mobile apps.

1. Directory Structure (Target State)

The project must strictly follow this tree.

**Target tree (must match):**

```
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
│   ├── mobile/           # React Native (Frontend)
│   │   ├── src/
│   │   ├── app.json
│   │   ├── metro.config.js # CRITICAL: Configured to watch packages/shared
│   │   ├── package.json    # Depends on "@chingoo/shared"
│   │   └── tsconfig.json
│   └── workers/          # REQUIRED (BullMQ processors)
│       ├── src/
│       ├── package.json  # Depends on "@chingoo/shared"
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
```


2. Initialization Script (Bash)
Use this script to scaffold the folders and initialize the monorepo logic.

**Run exactly (baseline scaffold):**

```bash
mkdir chingoo && cd chingoo
pnpm init
pnpm add turbo typescript -D -w
mkdir -p apps/api apps/mobile apps/workers
mkdir -p packages/shared/src/dto packages/shared/src/enums packages/shared/prisma
touch pnpm-workspace.yaml turbo.json tsconfig.base.json
cd packages/shared
pnpm init
cd ../..
```

**Note:** After running the above:
1. Manually edit `packages/shared/package.json` to set `"name": "@chingoo/shared"`.
2. Create root `.env.example` file with the environment variables template (see section 4.4 below).
3. Create root `docker-compose.yml` file for local development services (see section 3.D below).

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

C.1 Root turbo.json
Turborepo build pipeline configuration. Ensures `pnpm -w build` runs `tsc` in packages/shared.

{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "outputs": []
    },
    "db:generate": {
      "cache": false,
      "outputs": ["node_modules/.prisma/**"]
    },
    "db:push": {
      "cache": false
    }
  }
}

**Verification:** After scaffolding, run `pnpm -w build` to verify turbo runs `tsc` in packages/shared. The build should succeed if packages/shared has a valid `build: "tsc"` script and tsconfig.json.

D. Root docker-compose.yml

Docker services for local development (Postgres, Redis, Qdrant):

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: chingoo-postgres
    environment:
      POSTGRES_USER: chingoo
      POSTGRES_PASSWORD: chingoo
      POSTGRES_DB: chingoo
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chingoo"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: chingoo-redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  qdrant:
    image: qdrant/qdrant:v1.9.0
    container_name: chingoo-qdrant
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
  qdrant_data:
```

**Usage:** 
```bash
docker compose up -d
docker ps
```

Run `docker compose up -d` at root to start all services in detached mode. Use `docker ps` to verify all containers are running. Services match the `.env.example` default connection strings.

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

4.4 Root .env.example

Environment variables required (no secrets in example):

```env
# ---- Core ----
NODE_ENV=development

# ---- Postgres (Prisma reads DATABASE_URL) ----
DATABASE_URL=postgresql://chingoo:chingoo@localhost:5432/chingoo?schema=public

# ---- Redis (BullMQ) ----
REDIS_URL=redis://localhost:6379

# ---- Qdrant ----
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=memories

# ---- Auth (AWS Cognito JWT) ----
COGNITO_USER_POOL_ID=
COGNITO_REGION=
COGNITO_JWKS_URL=

# ---- Dev Auth Bypass (DEV ONLY - only if Cognito not ready yet) ----
# MINIMAL DEVIATION: Allows dev auth bypass when Cognito JWKS validation not available.
# Does not change PRODUCT intent (still token-based auth). Set to false in production.
DEV_BYPASS_AUTH=false
DEV_USER_SUB=dev-sub-0001

# ---- LLM / Embeddings ----
LLM_PROVIDER=openai
LLM_API_KEY=
EMBEDDING_MODEL_DIM=1536

# ---- Retention (quiet hours enforced in logic; timezone comes from onboarding) ----
RETENTION_MIN_LOCAL_HOUR=10
RETENTION_MAX_LOCAL_HOUR=21

# ---- Observability ----
LOG_LEVEL=debug
```

**Usage:** Copy `.env.example` to `.env` at root and fill in actual values. Apps (api, workers) should load from root `.env` or maintain per-app copies.

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

2. Metro Config (metro.config.js): CRITICAL: React Native's bundler does not support symlinks/monorepos out of the box. You MUST create this file in apps/mobile/ with appropriate configuration for your React Native setup to watch packages/shared and resolve workspace dependencies.

C. Workers (apps/workers)
1. Dependency: Add @chingoo/shared to package.json:

"dependencies": {
  "@chingoo/shared": "workspace:*",
  ...
}

2. Usage: Workers are BullMQ processors (NestJS Standalone Context) for background jobs (embedding, retention, decay).

6. Implementation Order for AI Agent
When scaffolding, follow this strict order:

1. Initialize Root: Create folders, pnpm-workspace.yaml, and package.json.

2. Scaffold Shared: Create packages/shared, paste SCHEMA.md content into packages/shared/prisma/schema.prisma, and create dummy DTO files. Run pnpm install.

3. Generate Client: Run pnpm prisma generate inside packages/shared.

4. Scaffold API: Initialize NestJS app in apps/api. Add workspace:* dependency.

5. Scaffold Mobile: Initialize React Native app in apps/mobile. Add workspace:* dependency. Create metro.config.js.

6. Scaffold Workers: Create apps/workers directory structure. Add workspace:* dependency to package.json. Workers is **REQUIRED** per SPEC_PATCH.md.

7. Docker Services: Create `docker-compose.yml` at root (see section 3.D). Run `docker compose up -d` to start Postgres, Redis, and Qdrant services. Verify with `docker ps`.

8. Environment Setup: Create `.env` file from `.env.example` at root. Each app (api, workers) should load environment variables from root `.env` or maintain their own copy.

9. Verify: Run pnpm build at root to ensure packages/shared compiles and is visible to apps.

