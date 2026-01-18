/**
 * Anti-Clone Service
 * 
 * Per AI_PIPELINE.md §3.4 and §3.4.1:
 * - combo_key = (core_archetype, humor_mode, friend_energy)
 * - Rolling 24-hour cap: no combo_key may be assigned to more than 7% of new users
 * - If cap would be exceeded, resample until compliant
 * 
 * Per AI_PIPELINE.md §3.4.1 Anti-Cloning Cap Math:
 * - Window: assignments with assigned_at >= now - 24h and < now
 * - max_allowed(N) = max(1, floor(0.07 * N))
 * - Candidate is allowed iff k_new <= max_allowed(N_new)
 * - Fallback: after MAX_RESAMPLES (50), choose combo_key with smallest k_prev
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { 
  CoreArchetype, 
  HumorMode, 
  FriendEnergy 
} from '@chingoo/shared';
import { 
  ComboKeyComponents, 
  ComboKeyStats, 
  AntiCloneCheckResult 
} from './types';

/**
 * Constants per AI_PIPELINE.md §3.4.1
 */
const ANTI_CLONE_CAP_PERCENTAGE = 0.07; // 7%
const MAX_RESAMPLES = 50;
const ROLLING_WINDOW_HOURS = 24;

@Injectable()
export class AntiCloneService {
  private readonly logger = new Logger(AntiCloneService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Build a combo key string from components
   * Per AI_PIPELINE.md §3.4: "combo_key = (core_archetype, humor_mode, friend_energy)"
   * Per SCHEMA.md B.14: combo_key format is "{core_archetype}:{humor_mode}:{friend_energy}"
   */
  buildComboKey(components: ComboKeyComponents): string {
    return `${components.core_archetype}:${components.humor_mode}:${components.friend_energy}`;
  }

  /**
   * Parse a combo key string into components
   */
  parseComboKey(comboKey: string): ComboKeyComponents {
    const [coreArchetype, humorMode, friendEnergy] = comboKey.split(':');
    return {
      core_archetype: coreArchetype as CoreArchetype,
      humor_mode: humorMode as HumorMode,
      friend_energy: friendEnergy as FriendEnergy,
    };
  }

  /**
   * Calculate max_allowed for a given N
   * Per AI_PIPELINE.md §3.4.1: max_allowed(N) = max(1, floor(0.07 * N))
   */
  calculateMaxAllowed(n: number): number {
    return Math.max(1, Math.floor(ANTI_CLONE_CAP_PERCENTAGE * n));
  }

  /**
   * Get the rolling 24h window start timestamp
   */
  private getWindowStart(): Date {
    const now = new Date();
    return new Date(now.getTime() - ROLLING_WINDOW_HOURS * 60 * 60 * 1000);
  }

  /**
   * Get all combo key statistics within the rolling 24h window
   * Per AI_PIPELINE.md §3.4.1: Window contains assignments with assigned_at >= now - 24h
   */
  async getComboKeyStats(): Promise<{
    stats: ComboKeyStats[];
    totalCount: number;
  }> {
    const windowStart = this.getWindowStart();

    // Query grouped counts per combo_key
    const groupedCounts = await this.prisma.personaAssignmentLog.groupBy({
      by: ['comboKey'],
      where: {
        assignedAt: {
          gte: windowStart,
        },
      },
      _count: {
        comboKey: true,
      },
    });

    const stats: ComboKeyStats[] = groupedCounts.map((g) => ({
      combo_key: g.comboKey,
      count: g._count.comboKey,
    }));

    const totalCount = stats.reduce((sum, s) => sum + s.count, 0);

    return { stats, totalCount };
  }

  /**
   * Check if a combo key would violate the anti-cloning cap
   * 
   * Per AI_PIPELINE.md §3.4.1:
   * - Let N_prev = total assignments in window
   * - Let k_prev(combo_key) = assignments in window for the candidate combo_key
   * - Evaluate the cap using N_new = N_prev + 1 and k_new = k_prev + 1
   * - Candidate is allowed iff k_new <= max_allowed(N_new)
   */
  async checkComboKey(comboKey: string): Promise<AntiCloneCheckResult> {
    const { stats, totalCount } = await this.getComboKeyStats();

    const n_prev = totalCount;
    const n_new = n_prev + 1;

    const existingStat = stats.find((s) => s.combo_key === comboKey);
    const k_prev = existingStat?.count ?? 0;
    const k_new = k_prev + 1;

    const max_allowed = this.calculateMaxAllowed(n_new);
    const is_allowed = k_new <= max_allowed;

    this.logger.debug(
      `Anti-clone check for ${comboKey}: n_prev=${n_prev}, n_new=${n_new}, ` +
      `k_prev=${k_prev}, k_new=${k_new}, max_allowed=${max_allowed}, allowed=${is_allowed}`
    );

    return {
      is_allowed,
      n_prev,
      n_new,
      k_prev,
      k_new,
      max_allowed,
    };
  }

  /**
   * Get all combo keys that are NOT at or above their cap
   * Returns combo keys that can still accept new assignments
   */
  async getAvailableComboKeys(
    allPossibleComboKeys: string[]
  ): Promise<string[]> {
    const { stats, totalCount } = await this.getComboKeyStats();
    const n_new = totalCount + 1;
    const max_allowed = this.calculateMaxAllowed(n_new);

    // Build a map of current counts
    const countMap = new Map<string, number>();
    for (const stat of stats) {
      countMap.set(stat.combo_key, stat.count);
    }

    // Filter to combo keys that would still be under cap
    const available = allPossibleComboKeys.filter((comboKey) => {
      const k_prev = countMap.get(comboKey) ?? 0;
      const k_new = k_prev + 1;
      return k_new <= max_allowed;
    });

    return available;
  }

  /**
   * Get the combo key with the smallest count (for fallback)
   * Per AI_PIPELINE.md §3.4.1:
   * "If still no compliant sample exists: choose the combo_key with the smallest k_prev"
   */
  async getLowestCountComboKey(
    candidates: string[]
  ): Promise<string | null> {
    if (candidates.length === 0) {
      return null;
    }

    const { stats } = await this.getComboKeyStats();
    const countMap = new Map<string, number>();
    for (const stat of stats) {
      countMap.set(stat.combo_key, stat.count);
    }

    // Sort candidates by count (ascending), then by key for determinism
    const sorted = [...candidates].sort((a, b) => {
      const countA = countMap.get(a) ?? 0;
      const countB = countMap.get(b) ?? 0;
      if (countA !== countB) {
        return countA - countB;
      }
      return a.localeCompare(b); // Deterministic tie-breaker
    });

    return sorted[0];
  }

  /**
   * Record a persona assignment in the log
   * Per SCHEMA.md B.14: persona_assignment_log tracks combo_key and assigned_at
   */
  async recordAssignment(
    userId: string,
    aiFriendId: string,
    comboKey: string
  ): Promise<void> {
    await this.prisma.personaAssignmentLog.upsert({
      where: {
        userId_aiFriendId: {
          userId,
          aiFriendId,
        },
      },
      create: {
        userId,
        aiFriendId,
        comboKey,
        assignedAt: new Date(),
      },
      update: {
        comboKey,
        assignedAt: new Date(),
      },
    });

    this.logger.log(
      `Recorded persona assignment: userId=${userId}, comboKey=${comboKey}`
    );
  }

  /**
   * Get the maximum number of resamples allowed
   * Per AI_PIPELINE.md §3.4.1: "Resample up to MAX_RESAMPLES = 50"
   */
  getMaxResamples(): number {
    return MAX_RESAMPLES;
  }
}
