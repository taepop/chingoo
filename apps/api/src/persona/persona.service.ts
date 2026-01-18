/**
 * Persona Service
 * 
 * Main orchestration for persona assignment during onboarding.
 * 
 * Per AI_PIPELINE.md §3.1 - When it runs:
 * "During ONBOARDING, after required questions are answered, before first message is sent."
 * 
 * Per AI_PIPELINE.md §3.3 - Sampling:
 * - Sample 1 core_archetype
 * - Sample 2–3 modifiers among speech_style, humor_mode, friend_energy
 * - Derive StableStyleParams
 * - Persist: persona_template_id, persona_seed (random 32-bit int), stable_style_params
 * 
 * Per AI_PIPELINE.md §3.4 - Anti-cloning cap (hard enforcement):
 * - combo_key: (core_archetype, humor_mode, friend_energy)
 * - rolling 24-hour cap: no combo key > 7% of new assignments
 * - if cap would be exceeded, resample until compliant
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SeededRandom, generatePersonaSeed } from '../common/utils/prng';
import { TopicId } from '@chingoo/shared';
import { AntiCloneService } from './anti-clone.service';
import { StableStyleParamsBuilder } from './stable-style-params.builder';
import { 
  PERSONA_TEMPLATES, 
  getPersonaTemplate 
} from './persona-templates.data';
import { 
  PersonaAssignment, 
  PersonaTemplate, 
  StableStyleParams,
  MutationCategory 
} from './types';

@Injectable()
export class PersonaService {
  private readonly logger = new Logger(PersonaService.name);

  constructor(
    private prisma: PrismaService,
    private antiCloneService: AntiCloneService,
    private stableStyleParamsBuilder: StableStyleParamsBuilder,
  ) {}

  /**
   * Assign a persona to a user's AI friend
   * 
   * This is the main entry point called during onboarding.
   * Implements the full persona assignment algorithm including:
   * 1. Generate persona_seed
   * 2. Sample a template
   * 3. Derive StableStyleParams with mutations
   * 4. Check anti-cloning cap
   * 5. Resample if needed
   * 6. Persist assignment
   * 
   * @param userId User ID
   * @param aiFriendId AI Friend ID
   * @returns PersonaAssignment
   */
  async assignPersona(userId: string, aiFriendId: string): Promise<PersonaAssignment> {
    this.logger.log(`Assigning persona for user ${userId}, aiFriend ${aiFriendId}`);

    // Step 1: Generate persona_seed (random 32-bit int)
    // Per AI_PIPELINE.md §3.3: "persona_seed (random 32-bit int)"
    const personaSeed = generatePersonaSeed();
    const prng = new SeededRandom(personaSeed);

    // Step 2-5: Sample and validate with anti-clone cap
    const assignment = await this.sampleAndValidatePersona(
      prng,
      personaSeed,
      userId,
      aiFriendId
    );

    // Step 6: Persist to database
    await this.persistAssignment(userId, aiFriendId, assignment);

    this.logger.log(
      `Persona assigned: template=${assignment.persona_template_id}, ` +
      `comboKey=${assignment.combo_key}`
    );

    return assignment;
  }

  /**
   * Sample a persona and validate against anti-clone cap
   * Implements the resampling logic per AI_PIPELINE.md §3.4.1
   */
  private async sampleAndValidatePersona(
    prng: SeededRandom,
    personaSeed: number,
    userId: string,
    aiFriendId: string
  ): Promise<PersonaAssignment> {
    const maxResamples = this.antiCloneService.getMaxResamples();
    let attempts = 0;
    let assignment: PersonaAssignment | null = null;
    const triedComboKeys = new Set<string>();

    while (attempts < maxResamples) {
      attempts++;

      // Sample a template
      // Per AI_PIPELINE.md §3.3: "Sample 1 core_archetype"
      const template = prng.pick(PERSONA_TEMPLATES);

      // Derive StableStyleParams with mutations (2 categories by default)
      // Per AI_PIPELINE.md §3.2.1: "Choose exactly 2 modifier categories to mutate"
      const derived = this.stableStyleParamsBuilder.deriveStableStyleParams(
        template,
        prng,
        2
      );

      // Build combo key
      const comboKeyComponents = this.stableStyleParamsBuilder.buildComboKeyComponents(
        template,
        derived.mutatedHumorMode,
        derived.mutatedFriendEnergy
      );
      const comboKey = this.antiCloneService.buildComboKey(comboKeyComponents);

      // Skip if we've already tried this combo
      if (triedComboKeys.has(comboKey)) {
        continue;
      }
      triedComboKeys.add(comboKey);

      // Check anti-clone cap
      const capCheck = await this.antiCloneService.checkComboKey(comboKey);

      if (capCheck.is_allowed) {
        // Success! Return this assignment
        assignment = {
          persona_template_id: template.id,
          persona_seed: personaSeed,
          stable_style_params: derived.stableStyleParams,
          taboo_soft_bounds: template.taboo_soft_bounds,
          combo_key: comboKey,
        };
        break;
      }

      this.logger.debug(
        `Attempt ${attempts}: combo_key ${comboKey} would exceed cap ` +
        `(k_new=${capCheck.k_new} > max=${capCheck.max_allowed}), resampling...`
      );

      // Per AI_PIPELINE.md §3.2.1:
      // "Third mutation category is applied if and only if anti-cloning cap would be violated"
      // Try with 3 mutations
      const derivedWith3 = this.stableStyleParamsBuilder.deriveStableStyleParams(
        template,
        prng,
        3
      );

      const comboKeyWith3Components = this.stableStyleParamsBuilder.buildComboKeyComponents(
        template,
        derivedWith3.mutatedHumorMode,
        derivedWith3.mutatedFriendEnergy
      );
      const comboKeyWith3 = this.antiCloneService.buildComboKey(comboKeyWith3Components);

      if (!triedComboKeys.has(comboKeyWith3)) {
        triedComboKeys.add(comboKeyWith3);
        const capCheck3 = await this.antiCloneService.checkComboKey(comboKeyWith3);

        if (capCheck3.is_allowed) {
          assignment = {
            persona_template_id: template.id,
            persona_seed: personaSeed,
            stable_style_params: derivedWith3.stableStyleParams,
            taboo_soft_bounds: template.taboo_soft_bounds,
            combo_key: comboKeyWith3,
          };
          break;
        }
      }
    }

    // Fallback if no compliant sample found
    // Per AI_PIPELINE.md §3.4.1:
    // "If still no compliant sample exists: choose the combo_key with the smallest k_prev"
    if (!assignment) {
      this.logger.warn(
        `No compliant combo_key found after ${maxResamples} attempts, using fallback`
      );
      assignment = await this.fallbackAssignment(prng, personaSeed);
    }

    return assignment;
  }

  /**
   * Fallback assignment when no compliant combo is found
   * 
   * Per AI_PIPELINE.md §3.4.1:
   * "choose the combo_key with the smallest k_prev in the window"
   * "tie-break deterministically using persona_seed PRNG order over the candidate list"
   */
  private async fallbackAssignment(
    prng: SeededRandom,
    personaSeed: number
  ): Promise<PersonaAssignment> {
    // Get all possible combo keys
    const allComboKeys: string[] = [];
    for (const template of PERSONA_TEMPLATES) {
      const comboKeysForTemplate = this.stableStyleParamsBuilder.getAllPossibleComboKeys(template);
      allComboKeys.push(...comboKeysForTemplate);
    }

    // Remove duplicates and shuffle deterministically
    const uniqueComboKeys = [...new Set(allComboKeys)];
    prng.shuffle(uniqueComboKeys);

    // Find the combo key with the lowest count
    const lowestComboKey = await this.antiCloneService.getLowestCountComboKey(uniqueComboKeys);

    if (!lowestComboKey) {
      // Absolute fallback: just pick a random template
      this.logger.error('No combo keys available, using random fallback');
      const template = prng.pick(PERSONA_TEMPLATES);
      const derived = this.stableStyleParamsBuilder.deriveStableStyleParams(template, prng, 2);
      const comboKeyComponents = this.stableStyleParamsBuilder.buildComboKeyComponents(
        template,
        derived.mutatedHumorMode,
        derived.mutatedFriendEnergy
      );
      
      return {
        persona_template_id: template.id,
        persona_seed: personaSeed,
        stable_style_params: derived.stableStyleParams,
        taboo_soft_bounds: template.taboo_soft_bounds,
        combo_key: this.antiCloneService.buildComboKey(comboKeyComponents),
      };
    }

    // Parse the combo key to find a matching template
    const components = this.antiCloneService.parseComboKey(lowestComboKey);
    
    // Find a template with this archetype
    const matchingTemplates = PERSONA_TEMPLATES.filter(
      t => t.core_archetype === components.core_archetype
    );
    const template = matchingTemplates.length > 0 
      ? prng.pick(matchingTemplates) 
      : prng.pick(PERSONA_TEMPLATES);

    // Create StableStyleParams that produce this combo key
    const derived = this.stableStyleParamsBuilder.deriveStableStyleParams(template, prng, 2);
    
    // Override humor_mode and friend_energy to match the target combo key
    derived.stableStyleParams.humor_mode = components.humor_mode;

    return {
      persona_template_id: template.id,
      persona_seed: personaSeed,
      stable_style_params: derived.stableStyleParams,
      taboo_soft_bounds: template.taboo_soft_bounds,
      combo_key: lowestComboKey,
    };
  }

  /**
   * Persist persona assignment to the database
   */
  private async persistAssignment(
    userId: string,
    aiFriendId: string,
    assignment: PersonaAssignment
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Update AiFriend with persona data
      await tx.aiFriend.update({
        where: { id: aiFriendId },
        data: {
          personaTemplateId: assignment.persona_template_id,
          personaSeed: assignment.persona_seed,
          stableStyleParams: assignment.stable_style_params as any,
          tabooSoftBounds: assignment.taboo_soft_bounds as any,
          assignedAt: new Date(),
        },
      });

      // Record in persona_assignment_log for anti-clone tracking
      await tx.personaAssignmentLog.upsert({
        where: {
          userId_aiFriendId: {
            userId,
            aiFriendId,
          },
        },
        create: {
          userId,
          aiFriendId,
          comboKey: assignment.combo_key,
          assignedAt: new Date(),
        },
        update: {
          comboKey: assignment.combo_key,
          assignedAt: new Date(),
        },
      });
    });
  }

  /**
   * Get the assigned persona for a user's AI friend
   */
  async getPersonaAssignment(aiFriendId: string): Promise<PersonaAssignment | null> {
    const aiFriend = await this.prisma.aiFriend.findUnique({
      where: { id: aiFriendId },
      include: {
        personaAssignmentLogs: true,
      },
    });

    if (!aiFriend || !aiFriend.personaTemplateId || !aiFriend.stableStyleParams) {
      return null;
    }

    const assignmentLog = aiFriend.personaAssignmentLogs[0];

    return {
      persona_template_id: aiFriend.personaTemplateId,
      persona_seed: aiFriend.personaSeed ?? 0,
      stable_style_params: aiFriend.stableStyleParams as unknown as StableStyleParams,
      taboo_soft_bounds: aiFriend.tabooSoftBounds as unknown as TopicId[],
      combo_key: assignmentLog?.comboKey ?? '',
    };
  }

  /**
   * Get persona template by ID
   */
  getTemplate(templateId: string): PersonaTemplate | undefined {
    return getPersonaTemplate(templateId);
  }

  /**
   * Get all templates (for seeding or debugging)
   */
  getAllTemplates(): PersonaTemplate[] {
    return PERSONA_TEMPLATES;
  }

  /**
   * Check if a user's AI friend has a persona assigned
   */
  async hasPersonaAssigned(aiFriendId: string): Promise<boolean> {
    const aiFriend = await this.prisma.aiFriend.findUnique({
      where: { id: aiFriendId },
      select: {
        personaTemplateId: true,
        stableStyleParams: true,
      },
    });

    return !!(aiFriend?.personaTemplateId && aiFriend?.stableStyleParams);
  }

  /**
   * Validate that required persona fields exist for ONBOARDING → ACTIVE transition
   * Per AI_PIPELINE.md §4.1.2:
   * "Re-check persona assignment exists (persona_template_id + stable_style_params)"
   */
  async validatePersonaForTransition(aiFriendId: string): Promise<{
    valid: boolean;
    missingFields: string[];
  }> {
    const aiFriend = await this.prisma.aiFriend.findUnique({
      where: { id: aiFriendId },
      select: {
        personaTemplateId: true,
        personaSeed: true,
        stableStyleParams: true,
      },
    });

    const missingFields: string[] = [];

    if (!aiFriend) {
      return { valid: false, missingFields: ['ai_friend'] };
    }

    if (!aiFriend.personaTemplateId) {
      missingFields.push('persona_template_id');
    }

    if (aiFriend.personaSeed === null) {
      missingFields.push('persona_seed');
    }

    if (!aiFriend.stableStyleParams) {
      missingFields.push('stable_style_params');
    }

    return {
      valid: missingFields.length === 0,
      missingFields,
    };
  }
}
