/**
 * StableStyleParams Builder
 * 
 * Per AI_PIPELINE.md §3.2.1 and PRODUCT.md §6.2.1:
 * 
 * StableStyleParams derivation:
 * - Start with template defaults
 * - Apply sampling mutations (see Sampling Mutations below)
 * - Freeze results as stable_style_params
 * 
 * Sampling Mutations (deterministic with persona_seed):
 * - Choose exactly 2 modifier categories to mutate from {speech_style, humor_mode, friend_energy}
 * - Mutation rule: choose a value != template default, using persona_seed PRNG
 * - Third mutation category is applied if and only if anti-cloning cap would be violated
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SentenceLengthBias,
  EmojiUsage,
  HumorMode,
  FriendEnergy,
  DirectnessLevel,
  FollowupQuestionRate,
  LexiconBias,
} from '@chingoo/shared';
import { SeededRandom } from '../common/utils/prng';
import { 
  PersonaTemplate, 
  StableStyleParams, 
  MutationCategory,
  ComboKeyComponents 
} from './types';

/**
 * All possible values for each mutable field
 */
const ALL_HUMOR_MODES: HumorMode[] = [
  HumorMode.NONE,
  HumorMode.LIGHT_SARCASM,
  HumorMode.FREQUENT_JOKES,
  HumorMode.DEADPAN,
];

const ALL_FRIEND_ENERGIES: FriendEnergy[] = [
  FriendEnergy.PASSIVE,
  FriendEnergy.BALANCED,
  FriendEnergy.PROACTIVE,
];

const ALL_SENTENCE_LENGTHS: SentenceLengthBias[] = [
  SentenceLengthBias.SHORT,
  SentenceLengthBias.MEDIUM,
  SentenceLengthBias.LONG,
];

const ALL_EMOJI_USAGES: EmojiUsage[] = [
  EmojiUsage.NONE,
  EmojiUsage.LIGHT,
  EmojiUsage.FREQUENT,
];

const ALL_DIRECTNESS_LEVELS: DirectnessLevel[] = [
  DirectnessLevel.SOFT,
  DirectnessLevel.BALANCED,
  DirectnessLevel.BLUNT,
];

const ALL_FOLLOWUP_RATES: FollowupQuestionRate[] = [
  FollowupQuestionRate.LOW,
  FollowupQuestionRate.MEDIUM,
];

const ALL_MUTATION_CATEGORIES: MutationCategory[] = [
  'speech_style',
  'humor_mode',
  'friend_energy',
];

@Injectable()
export class StableStyleParamsBuilder {
  private readonly logger = new Logger(StableStyleParamsBuilder.name);

  /**
   * Derive StableStyleParams from a PersonaTemplate with mutations
   * 
   * Per AI_PIPELINE.md §3.2.1:
   * - Choose exactly 2 modifier categories to mutate
   * - Mutation rule: choose a value != template default
   * - Uses persona_seed for deterministic randomness
   * 
   * @param template The PersonaTemplate to derive from
   * @param prng SeededRandom instance for deterministic sampling
   * @param mutateCategoriesCount Number of categories to mutate (default 2, can be 3 for anti-clone fallback)
   */
  deriveStableStyleParams(
    template: PersonaTemplate,
    prng: SeededRandom,
    mutateCategoriesCount: number = 2,
  ): {
    stableStyleParams: StableStyleParams;
    mutatedHumorMode: HumorMode;
    mutatedFriendEnergy: FriendEnergy;
  } {
    // Start with template defaults
    let msgLengthPref = template.speech_style.sentence_length_bias;
    let emojiFreq = template.speech_style.emoji_usage;
    let humorMode = template.humor_mode;
    let friendEnergy = template.friend_energy;
    let lexiconBias = template.lexicon_bias.language_cleanliness;
    let punctuationQuirks = [...template.speech_style.punctuation_quirks];

    // Select which categories to mutate
    // Per AI_PIPELINE.md §3.2.1: "Choose exactly 2 modifier categories to mutate"
    const categoriesToMutate = prng.sample(
      [...ALL_MUTATION_CATEGORIES],
      Math.min(mutateCategoriesCount, ALL_MUTATION_CATEGORIES.length)
    );

    this.logger.debug(
      `Mutating categories: ${categoriesToMutate.join(', ')} for template ${template.id}`
    );

    // Apply mutations to selected categories
    for (const category of categoriesToMutate) {
      switch (category) {
        case 'speech_style':
          // Mutate sentence_length_bias and/or emoji_usage
          msgLengthPref = prng.pickExcluding(
            ALL_SENTENCE_LENGTHS,
            template.speech_style.sentence_length_bias
          );
          // Optionally also mutate emoji usage
          if (prng.next() > 0.5) {
            emojiFreq = prng.pickExcluding(
              ALL_EMOJI_USAGES,
              template.speech_style.emoji_usage
            );
          }
          break;

        case 'humor_mode':
          // Per AI_PIPELINE.md §3.2.1: "choose a value != template default"
          humorMode = prng.pickExcluding(ALL_HUMOR_MODES, template.humor_mode);
          break;

        case 'friend_energy':
          // Per AI_PIPELINE.md §3.2.1: "choose a value != template default"
          friendEnergy = prng.pickExcluding(
            ALL_FRIEND_ENERGIES,
            template.friend_energy
          );
          break;
      }
    }

    // Derive directness_level based on archetype and mutations
    // Per AI_PIPELINE.md §2.4: directness_level = soft | balanced | blunt
    const directnessLevel = this.deriveDirectnessLevel(template, prng);

    // Derive followup_question_rate
    // Per PRODUCT.md §6.6: followup_question_rate = low | medium (never "high" in v0.1)
    const followupQuestionRate = prng.pick(ALL_FOLLOWUP_RATES);

    const stableStyleParams: StableStyleParams = {
      msg_length_pref: msgLengthPref,
      emoji_freq: emojiFreq,
      humor_mode: humorMode,
      directness_level: directnessLevel,
      followup_question_rate: followupQuestionRate,
      lexicon_bias: lexiconBias,
      punctuation_quirks: punctuationQuirks,
    };

    return {
      stableStyleParams,
      mutatedHumorMode: humorMode,
      mutatedFriendEnergy: friendEnergy,
    };
  }

  /**
   * Derive directness level based on archetype
   * Some archetypes are naturally more direct than others
   */
  private deriveDirectnessLevel(
    template: PersonaTemplate,
    prng: SeededRandom
  ): DirectnessLevel {
    // Blunt Honest and Dry Humor archetypes lean towards blunt
    const bluntArchetypes = ['Blunt_Honest', 'Dry_Humor'];
    // Calm Listener, Warm Caregiver lean towards soft
    const softArchetypes = ['Calm_Listener', 'Warm_Caregiver', 'Gentle_Coach'];

    if (bluntArchetypes.includes(template.core_archetype)) {
      // 70% chance of blunt, 30% balanced
      return prng.next() < 0.7 ? DirectnessLevel.BLUNT : DirectnessLevel.BALANCED;
    } else if (softArchetypes.includes(template.core_archetype)) {
      // 70% chance of soft, 30% balanced
      return prng.next() < 0.7 ? DirectnessLevel.SOFT : DirectnessLevel.BALANCED;
    } else {
      // Others get random from all options
      return prng.pick(ALL_DIRECTNESS_LEVELS);
    }
  }

  /**
   * Build combo key components from template and mutated values
   * Per AI_PIPELINE.md §3.4: combo_key = (core_archetype, humor_mode, friend_energy)
   */
  buildComboKeyComponents(
    template: PersonaTemplate,
    mutatedHumorMode: HumorMode,
    mutatedFriendEnergy: FriendEnergy
  ): ComboKeyComponents {
    return {
      core_archetype: template.core_archetype,
      humor_mode: mutatedHumorMode,
      friend_energy: mutatedFriendEnergy,
    };
  }

  /**
   * Re-derive with additional mutations when anti-clone cap is violated
   * 
   * Per AI_PIPELINE.md §3.2.1:
   * "Third mutation category is applied if and only if anti-cloning cap would be violated"
   * 
   * This method applies an additional mutation to the third category
   */
  applyAdditionalMutation(
    template: PersonaTemplate,
    currentParams: StableStyleParams,
    alreadyMutated: MutationCategory[],
    prng: SeededRandom
  ): {
    stableStyleParams: StableStyleParams;
    mutatedHumorMode: HumorMode;
    mutatedFriendEnergy: FriendEnergy;
  } {
    // Find the category that wasn't mutated
    const remainingCategory = ALL_MUTATION_CATEGORIES.find(
      (c) => !alreadyMutated.includes(c)
    );

    if (!remainingCategory) {
      // All categories already mutated, just return current
      return {
        stableStyleParams: currentParams,
        mutatedHumorMode: currentParams.humor_mode,
        mutatedFriendEnergy: template.friend_energy, // This needs proper tracking
      };
    }

    // Clone current params
    const newParams: StableStyleParams = { ...currentParams };
    let mutatedHumorMode = currentParams.humor_mode;
    let mutatedFriendEnergy = template.friend_energy;

    // Apply mutation to the remaining category
    switch (remainingCategory) {
      case 'speech_style':
        newParams.msg_length_pref = prng.pickExcluding(
          ALL_SENTENCE_LENGTHS,
          template.speech_style.sentence_length_bias
        );
        break;

      case 'humor_mode':
        mutatedHumorMode = prng.pickExcluding(
          ALL_HUMOR_MODES,
          template.humor_mode
        );
        newParams.humor_mode = mutatedHumorMode;
        break;

      case 'friend_energy':
        mutatedFriendEnergy = prng.pickExcluding(
          ALL_FRIEND_ENERGIES,
          template.friend_energy
        );
        break;
    }

    this.logger.debug(
      `Applied additional mutation to category: ${remainingCategory}`
    );

    return {
      stableStyleParams: newParams,
      mutatedHumorMode,
      mutatedFriendEnergy,
    };
  }

  /**
   * Get all possible combo keys for a given template
   * Used for anti-clone fallback to find the least-used combination
   */
  getAllPossibleComboKeys(template: PersonaTemplate): string[] {
    const comboKeys: string[] = [];
    
    for (const humorMode of ALL_HUMOR_MODES) {
      for (const friendEnergy of ALL_FRIEND_ENERGIES) {
        comboKeys.push(
          `${template.core_archetype}:${humorMode}:${friendEnergy}`
        );
      }
    }

    return comboKeys;
  }
}
