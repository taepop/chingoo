/**
 * Persona Module
 * 
 * Per ARCHITECTURE.md Section B - Folder Structure:
 * apps/api/src/persona/ - Persona template + assignment
 * 
 * This module provides:
 * - PersonaService: Main orchestration for persona assignment
 * - AntiCloneService: 7% rolling 24h cap enforcement
 * - StableStyleParamsBuilder: Derive StableStyleParams with mutations
 * - Persona templates data (24 templates per PRODUCT.md §6.2.1)
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PersonaService } from './persona.service';
import { AntiCloneService } from './anti-clone.service';
import { StableStyleParamsBuilder } from './stable-style-params.builder';

@Module({
  imports: [PrismaModule],
  providers: [
    PersonaService,
    AntiCloneService,
    StableStyleParamsBuilder,
  ],
  exports: [
    PersonaService,
    AntiCloneService,
    StableStyleParamsBuilder,
  ],
})
export class PersonaModule {}
