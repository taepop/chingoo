# VERSIONS.md — Dependency Constraints & Technology Stack

> **CRITICAL INSTRUCTION FOR AI AGENTS:**
> You MUST adhere to these exact versions to prevent dependency drift and ecosystem incompatibility.
> Stability is prioritized over novelty. Do not upgrade to "latest" if it violates the major version constraints below.

## 1. Runtime Environment
| Component | Version Constraint | Notes |
|-----------|--------------------|-------|
| **Node.js** | `v20.x` (LTS "Iron") | Strict requirement. Do not use v21/v22 yet. |
| **Package Manager** | `pnpm` (v9.x) | **Mandatory.** Do not use npm or yarn. Required for Monorepo workspace support. |

## 2. Backend Stack (`apps/api`)
| Library | Version Constraint | Context |
|---------|--------------------|---------|
| **Framework** | `NestJS v10.x` (Stable) | **Do NOT use v11.** Core logic depends on v10 stability. |
| **Platform** | `@nestjs/platform-fastify` | **Do NOT use Express.** Performance requirement. |
| **ORM** | `Prisma v5.x` | Latest stable v5. Ensure `@prisma/client` matches CLI version. |
| **Validation** | `class-validator` / `class-transformer` | Standard NestJS validation pipes. |
| **Queues** | `bullmq@^5.0.0` | Do not use legacy `bull`. |
| **Testing** | `jest@^29.0.0` | Standard NestJS testing harness. |

## 3. Mobile Stack (`apps/mobile`)
| Library | Version Constraint | Context |
|---------|--------------------|---------|
| **Expo SDK** | `SDK 52` | **Latest Stable.** strictly paired with React Native version below. |
| **React Native** | `0.76.x` | New Architecture enabled. |
| **Router** | `expo-router@^3.5.x` or `^4.0.0` | File-based routing (check SDK 52 compatibility). |
| **Storage** | `react-native-mmkv` | High-performance storage replacement for AsyncStorage. |
| **Styling** | `tamagui` OR `nativewind` | Preference: Typesafe styling. |

## 4. Infrastructure Services (Docker)
| Service | Image Tag | Notes |
|---------|-----------|-------|
| **PostgreSQL** | `postgres:16-alpine` | Source of truth. |
| **Redis** | `redis:7-alpine` | Required for BullMQ and Caching. |
| **Qdrant** | `qdrant/qdrant:v1.9.x` | Vector Database. |

---

## 5. ❌ FORBIDDEN LIST (DO NOT USE)

The following technologies or versions are **strictly prohibited** to ensure architectural integrity:

1.  **NO NestJS v11 (Beta/RC):** It breaks specific ecosystem plugins we rely on. Stick to v10.
2.  **NO Express.js:** The backend is configured for Fastify (`@nestjs/platform-fastify`).
3.  **NO TypeORM / Sequelize:** We use Prisma exclusively.
4.  **NO JavaScript source files:** All code must be strict TypeScript (`.ts` / `.tsx`).
5.  **NO `yarn` or `npm install`:** You must use `pnpm install` to respect workspace symlinks.
6.  **NO Supabase Auth:** We are using AWS Cognito (JWT) per the spec.