import { Module } from '@nestjs/common';
import { UserController } from './user.controller';

/**
 * User Module
 * Endpoints:
 * - POST /user/onboarding
 * - GET /user/me
 * - PATCH /user/timezone
 * - POST /user/device (SPEC_PATCH.md addition)
 * - DELETE /user/me (SPEC_PATCH.md addition)
 */
@Module({
  controllers: [UserController],
})
export class UserModule {}
