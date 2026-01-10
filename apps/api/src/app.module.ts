import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ChatModule } from './chat/chat.module';
import { TraceModule } from './trace/trace.module';
import { TraceMiddleware } from './trace/trace.middleware';

/**
 * Root Application Module
 * 
 * Scaffolded modules for endpoints per API_CONTRACT.md and SPEC_PATCH.md:
 * - AuthModule: POST /auth/login
 * - UserModule: POST /user/onboarding, GET /user/me, PATCH /user/timezone, POST /user/device, DELETE /user/me
 * - ChatModule: POST /chat/send, GET /chat/history
 * 
 * Note: No /health endpoint per spec requirements.
 */
@Module({
  imports: [TraceModule, AuthModule, UserModule, ChatModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
