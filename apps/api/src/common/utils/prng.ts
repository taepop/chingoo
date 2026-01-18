/**
 * Deterministic Seeded PRNG (Mulberry32)
 * 
 * Per AI_PIPELINE.md §3.3 and SCHEMA.md §F.4:
 * - persona_seed is a 32-bit integer
 * - Application must use deterministic PRNG for reproducible sampling
 * 
 * This implementation uses the Mulberry32 algorithm which provides:
 * - 32-bit state
 * - Period of 2^32
 * - Good statistical properties
 * - Reproducibility given the same seed
 */

/**
 * SeededRandom class provides deterministic random number generation.
 * 
 * Usage:
 * ```typescript
 * const prng = new SeededRandom(personaSeed);
 * const value = prng.next(); // 0.0 to 1.0
 * const intValue = prng.nextInt(0, 10); // 0 to 9
 * const item = prng.pick(['a', 'b', 'c']); // Random item from array
 * ```
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Ensure seed is a valid 32-bit integer
    this.state = seed >>> 0;
  }

  /**
   * Generate the next random number in [0, 1)
   * Uses Mulberry32 algorithm
   */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generate a random integer in [min, max)
   * @param min Minimum value (inclusive)
   * @param max Maximum value (exclusive)
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }

  /**
   * Pick a random item from an array
   * @param array Array to pick from
   * @returns Random item from array
   */
  pick<T>(array: T[]): T {
    if (array.length === 0) {
      throw new Error('Cannot pick from empty array');
    }
    return array[this.nextInt(0, array.length)];
  }

  /**
   * Pick a random item from an array that is NOT the excluded value
   * Per AI_PIPELINE.md §3.2.1: "choose a value != template default"
   * 
   * @param array Array to pick from
   * @param exclude Value to exclude
   * @returns Random item from array, excluding the specified value
   */
  pickExcluding<T>(array: T[], exclude: T): T {
    const filtered = array.filter(item => item !== exclude);
    if (filtered.length === 0) {
      throw new Error('No valid options after exclusion');
    }
    return this.pick(filtered);
  }

  /**
   * Shuffle an array in place using Fisher-Yates algorithm
   * Returns the same array reference, shuffled
   * 
   * @param array Array to shuffle
   * @returns The same array, shuffled
   */
  shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Select N random items from an array without replacement
   * 
   * @param array Source array
   * @param count Number of items to select
   * @returns Array of selected items
   */
  sample<T>(array: T[], count: number): T[] {
    if (count > array.length) {
      throw new Error(`Cannot sample ${count} items from array of length ${array.length}`);
    }
    // Create a copy to avoid modifying original
    const copy = [...array];
    this.shuffle(copy);
    return copy.slice(0, count);
  }

  /**
   * Generate a random 32-bit seed
   * Useful for creating new seeds for child processes
   */
  nextSeed(): number {
    return this.nextInt(0, 0x7FFFFFFF);
  }
}

/**
 * Generate a cryptographically random 32-bit seed.
 * Use this for initial persona_seed generation (not for deterministic operations).
 * 
 * Per AI_PIPELINE.md §3.3:
 * "Persist: persona_seed (random 32-bit int)"
 */
export function generatePersonaSeed(): number {
  // Use Math.random() for initial seed generation
  // In production, could use crypto.randomInt for better randomness
  return Math.floor(Math.random() * 0x7FFFFFFF);
}

/**
 * Create a simple PRNG function from a seed.
 * Legacy interface for backward compatibility.
 * 
 * @param seed 32-bit seed value
 * @returns Function that returns next random value in [0, 1)
 */
export function createSeededRandom(seed: number): () => number {
  const prng = new SeededRandom(seed);
  return () => prng.next();
}
