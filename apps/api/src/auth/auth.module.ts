import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PrismaModule } from '../prisma/prisma.module';

// Boot-time guard: fail if JWT_SECRET is missing (prevents silent 500s)
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.DEV_BYPASS_AUTH === 'true') {
      // In dev bypass mode, use a default secret
      return 'dev-secret-change-in-production';
    }
    throw new Error(
      'JWT_SECRET environment variable is required. Set JWT_SECRET or enable DEV_BYPASS_AUTH=true',
    );
  }
  return secret;
};

@Module({
  imports: [
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      // Use registerAsync to read JWT_SECRET at runtime (after env vars are set in tests)
      useFactory: async () => ({
        secret: getJwtSecret(),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtStrategy],
})
export class AuthModule {}
