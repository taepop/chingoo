import { Module } from '@nestjs/common';
import { RelationshipService } from './relationship.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [RelationshipService],
  exports: [RelationshipService],
})
export class RelationshipModule {}
