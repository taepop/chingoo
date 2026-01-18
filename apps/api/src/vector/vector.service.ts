import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';

/**
 * VectorService
 * 
 * Implements vector storage and semantic search per AI_PIPELINE.md §13:
 * - Collection: chingoo_memories
 * - Dimension: 1536 (OpenAI text-embedding-3-small)
 * - Distance: Cosine
 * - topK: 4 per spec
 * 
 * Per SCHEMA.md §D.1 - Qdrant Collection Schema:
 * Payload includes: memory_id, user_id, ai_friend_id, memory_type, memory_key, memory_value, status, created_at
 */

const COLLECTION_NAME = 'chingoo_memories';
const EMBEDDING_DIMENSION = 1536; // OpenAI text-embedding-3-small
const TOP_K = 4; // Per AI_PIPELINE.md §13

/**
 * Memory payload stored in Qdrant
 */
export interface MemoryPayload {
  memory_id: string;
  user_id: string;
  ai_friend_id: string;
  memory_type: string;
  memory_key: string;
  memory_value: string;
  status: string;
  created_at: string;
}

/**
 * Input for upserting a memory to vector store
 */
export interface VectorUpsertInput {
  memoryId: string;
  userId: string;
  aiFriendId: string;
  memoryType: string;
  memoryKey: string;
  memoryValue: string;
  createdAt: Date;
}

/**
 * Input for semantic search
 */
export interface VectorSearchInput {
  userId: string;
  aiFriendId: string;
  queryText: string;
  suppressedMemoryKeys?: string[];
}

/**
 * Result from semantic search
 */
export interface VectorSearchResult {
  memoryId: string;
  memoryKey: string;
  memoryValue: string;
  memoryType: string;
  score: number;
}

@Injectable()
export class VectorService implements OnModuleInit {
  private readonly logger = new Logger(VectorService.name);
  private client: QdrantClient | null = null;
  private readonly openaiApiKey: string;
  private readonly openaiEmbeddingUrl = 'https://api.openai.com/v1/embeddings';
  private readonly embeddingModel = 'text-embedding-3-small';
  private isEnabled = false;

  constructor() {
    // Read configuration from environment
    const qdrantUrl = process.env.QDRANT_URL;
    const qdrantApiKey = process.env.QDRANT_API_KEY;
    this.openaiApiKey = (process.env.LLM_API_KEY || '').trim();

    if (!qdrantUrl || !qdrantApiKey) {
      this.logger.warn(
        'QDRANT_URL or QDRANT_API_KEY not set. Vector search will be disabled. ' +
        'Set these in .env to enable semantic memory search.',
      );
      return;
    }

    if (!this.openaiApiKey) {
      this.logger.warn(
        'LLM_API_KEY not set. Vector embeddings will be disabled.',
      );
      return;
    }

    try {
      this.client = new QdrantClient({
        url: qdrantUrl,
        apiKey: qdrantApiKey,
      });
      this.isEnabled = true;
      this.logger.log(`VectorService initialized with Qdrant at ${qdrantUrl}`);
    } catch (error) {
      this.logger.error('Failed to initialize Qdrant client:', error);
    }
  }

  async onModuleInit() {
    if (!this.isEnabled || !this.client) {
      return;
    }

    // Ensure collection exists with correct schema
    await this.ensureCollection();
  }

  /**
   * Ensure the chingoo_memories collection exists.
   * Per SCHEMA.md §D.1 - Qdrant Collection Schema
   */
  private async ensureCollection(): Promise<void> {
    if (!this.client) return;

    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === COLLECTION_NAME);

      if (!exists) {
        this.logger.log(`Creating Qdrant collection: ${COLLECTION_NAME}`);
        await this.client.createCollection(COLLECTION_NAME, {
          vectors: {
            size: EMBEDDING_DIMENSION,
            distance: 'Cosine',
          },
        });

        // Create payload indexes for efficient filtering
        // Per SCHEMA.md §D.1 Payload indexes
        await this.client.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'user_id',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'ai_friend_id',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'status',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'memory_key',
          field_schema: 'keyword',
        });

        this.logger.log(`Collection ${COLLECTION_NAME} created with indexes`);
      } else {
        this.logger.log(`Collection ${COLLECTION_NAME} already exists`);
      }
    } catch (error) {
      this.logger.error('Failed to ensure Qdrant collection:', error);
    }
  }

  /**
   * Generate embedding for text using OpenAI API.
   * Uses text-embedding-3-small (1536 dimensions) for cost efficiency.
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.openaiApiKey) {
      this.logger.warn('Cannot generate embedding: LLM_API_KEY not set');
      return null;
    }

    try {
      const response = await fetch(this.openaiEmbeddingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`OpenAI embedding error: ${response.status} - ${errorText}`);
        return null;
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };

      return data.data[0]?.embedding ?? null;
    } catch (error) {
      this.logger.error('Failed to generate embedding:', error);
      return null;
    }
  }

  /**
   * Upsert a memory to the vector store.
   * Per SCHEMA.md §D.1: "After memory INSERT/UPDATE with status=ACTIVE, enqueue embedding job"
   * 
   * For v0.1 MVP, we do synchronous embedding (no BullMQ job queue).
   * 
   * @param input - Memory data to index
   * @returns Qdrant point ID or null if failed
   */
  async upsertMemory(input: VectorUpsertInput): Promise<string | null> {
    if (!this.isEnabled || !this.client) {
      this.logger.debug('Vector service disabled, skipping upsert');
      return null;
    }

    // Create text for embedding: combine key and value
    const textToEmbed = `${input.memoryKey}: ${input.memoryValue}`;
    
    const embedding = await this.generateEmbedding(textToEmbed);
    if (!embedding) {
      this.logger.warn(`Failed to generate embedding for memory ${input.memoryId}`);
      return null;
    }

    // Use memory ID as point ID for easy sync with Postgres
    const pointId = input.memoryId;

    const payload: Record<string, unknown> = {
      memory_id: input.memoryId,
      user_id: input.userId,
      ai_friend_id: input.aiFriendId,
      memory_type: input.memoryType,
      memory_key: input.memoryKey,
      memory_value: input.memoryValue,
      status: 'ACTIVE',
      created_at: input.createdAt.toISOString(),
    };

    try {
      await this.client.upsert(COLLECTION_NAME, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: embedding,
            payload,
          },
        ],
      });

      this.logger.debug(`Upserted memory ${input.memoryId} to Qdrant`);
      return pointId;
    } catch (error) {
      this.logger.error(`Failed to upsert memory ${input.memoryId} to Qdrant:`, error);
      return null;
    }
  }

  /**
   * Delete a memory from the vector store.
   * Per SCHEMA.md §D.1: "On status change to SUPERSEDED/INVALID, delete point from Qdrant"
   */
  async deleteMemory(memoryId: string): Promise<boolean> {
    if (!this.isEnabled || !this.client) {
      return false;
    }

    try {
      await this.client.delete(COLLECTION_NAME, {
        wait: true,
        points: [memoryId],
      });
      this.logger.debug(`Deleted memory ${memoryId} from Qdrant`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete memory ${memoryId} from Qdrant:`, error);
      return false;
    }
  }

  /**
   * Semantic search for relevant memories.
   * Per AI_PIPELINE.md §13 - Vector Retrieval (Qdrant):
   * - query text = retrieval_query_text or user_text_norm
   * - topK = 4
   * - filter: user_id + ai_friend_id + status=ACTIVE + exclude suppressed keys
   * 
   * @param input - Search parameters
   * @returns Array of relevant memories (up to topK)
   */
  async searchMemories(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    if (!this.isEnabled || !this.client) {
      this.logger.debug('Vector service disabled, returning empty results');
      return [];
    }

    const embedding = await this.generateEmbedding(input.queryText);
    if (!embedding) {
      this.logger.warn('Failed to generate query embedding');
      return [];
    }

    // Build filter per spec
    // Per AI_PIPELINE.md §13: filter by user_id, ai_friend_id, status=ACTIVE, exclude suppressed keys
    const mustFilters: Array<{ key: string; match: { value: string } }> = [
      { key: 'user_id', match: { value: input.userId } },
      { key: 'ai_friend_id', match: { value: input.aiFriendId } },
      { key: 'status', match: { value: 'ACTIVE' } },
    ];

    // Build must_not filter for suppressed memory keys
    const mustNotFilters: Array<{ key: string; match: { value: string } }> = [];
    if (input.suppressedMemoryKeys && input.suppressedMemoryKeys.length > 0) {
      for (const suppressedKey of input.suppressedMemoryKeys) {
        mustNotFilters.push({ key: 'memory_key', match: { value: suppressedKey } });
      }
    }

    try {
      const searchResult = await this.client.search(COLLECTION_NAME, {
        vector: embedding,
        limit: TOP_K,
        filter: {
          must: mustFilters,
          must_not: mustNotFilters.length > 0 ? mustNotFilters : undefined,
        },
        with_payload: true,
      });

      return searchResult.map(point => {
        const payload = point.payload as unknown as MemoryPayload;
        return {
          memoryId: payload.memory_id,
          memoryKey: payload.memory_key,
          memoryValue: payload.memory_value,
          memoryType: payload.memory_type,
          score: point.score,
        };
      });
    } catch (error) {
      this.logger.error('Failed to search memories in Qdrant:', error);
      return [];
    }
  }

  /**
   * Check if vector service is enabled and ready.
   */
  isReady(): boolean {
    return this.isEnabled && this.client !== null;
  }
}
