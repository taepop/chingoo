import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * Auth Module
 * Endpoint: POST /auth/login (or Signup)
 * Per SPEC_PATCH.md: /auth/signup is NOT implemented as a separate endpoint in v0.1.
 */
@Module({
  controllers: [AuthController],
})
export class AuthModule {}
