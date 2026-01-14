import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ChatModule } from './chat/chat.module';
import { PrismaModule } from './prisma/prisma.module';
import { TraceModule } from './trace/trace.module';
import { TopicMatchModule } from './topicmatch/topicmatch.module';
import { RouterModule } from './router/router.module';
import { JwtAuthGuard } from './auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    TraceModule,
    AuthModule,
    UserModule,
    ChatModule,
    TopicMatchModule,
    RouterModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
