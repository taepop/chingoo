import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';

// Load environment variables from both root and apps/api directories
// This ensures .env files are loaded before NestJS starts
function loadEnvFile(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          const [key, ...valueParts] = trimmedLine.split('=');
          if (key) {
            const value = valueParts.join('=').trim();
            // Remove quotes if present
            const cleanValue = value.replace(/^["']|["']$/g, '');
            if (!process.env[key.trim()]) {
              process.env[key.trim()] = cleanValue;
            }
          }
        }
      }
      return true;
    }
  } catch (error) {
    // Silently fail if .env file doesn't exist or can't be read
  }
  return false;
}

// Resolve paths - try multiple strategies to find .env files
// When running `pnpm --filter api dev` from root, process.cwd() is the monorepo root
// When running directly from apps/api, process.cwd() is apps/api

// Strategy 1: Assume we're at monorepo root (pnpm --filter case)
const rootEnv = path.resolve(process.cwd(), '.env');
const apiEnv = path.resolve(process.cwd(), 'apps/api/.env');

// Strategy 2: Assume we're in apps/api directory
const apiDirEnv = path.resolve(process.cwd(), '.env');
const apiDirRootEnv = path.resolve(process.cwd(), '../../.env');

// Strategy 3: From __dirname (works in compiled/bundled code)
let dirnamePaths: string[] = [];
try {
  // __dirname in bundled code points to dist/ directory
  const distDir = __dirname;
  const apiDir = path.resolve(distDir, '..'); // apps/api
  const monorepoRoot = path.resolve(apiDir, '../..'); // root
  dirnamePaths = [
    path.resolve(monorepoRoot, '.env'),
    path.resolve(apiDir, '.env'),
  ];
} catch {
  // __dirname might not be available in all contexts
}

// Try all possible paths in order of likelihood
const envPaths = [
  rootEnv,           // Most likely: root .env when using pnpm --filter
  apiEnv,            // apps/api/.env when using pnpm --filter
  apiDirEnv,         // .env when running from apps/api directly
  apiDirRootEnv,     // ../../.env when running from apps/api
  ...dirnamePaths,   // Paths based on __dirname
].filter((p): p is string => p !== null && p !== undefined);

// Load all found .env files (later files override earlier ones)
let loadedAny = false;
for (const envPath of envPaths) {
  if (loadEnvFile(envPath)) {
    loadedAny = true;
  }
}

// Debug: Log if no .env files were loaded (only in development)
if (!loadedAny && process.env.NODE_ENV !== 'production') {
  console.warn('[Env Loader] No .env files found. Tried paths:', envPaths);
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // Enable CORS for mobile app
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
