import { Injectable, Logger } from '@nestjs/common';
import { Pipeline, HeuristicFlags } from '../router/router.service';
import { RelationshipStage } from '@prisma/client';

/**
 * LLM generation context
 * 
 * Per AI_PIPELINE.md §9 (Stage E - Prompt Construction):
 * "Prompt contains: System rules, Persona constraints, RelationshipStage instructions,
 *  Memory snippets, Conversation recent turns, ResponsePlan"
 */
export interface LlmGenerationContext {
  /** User message text */
  userMessage: string;
  
  /** Routing pipeline type */
  pipeline: Pipeline;
  
  /** Whether this is the first message (greeting context) */
  isFirstMessage: boolean;
  
  /** Correction result from memory service (if applicable) */
  correctionResult?: {
    invalidated_memory_ids: string[];
    needs_clarification: boolean;
  } | null;
  
  /** Heuristic flags from routing */
  heuristicFlags?: HeuristicFlags;
  
  /** Stable style params for persona constraints (optional) */
  stableStyleParams?: {
    msg_length_pref?: 'short' | 'medium' | 'long';
    emoji_freq?: 'none' | 'light' | 'frequent';
    humor_mode?: 'none' | 'light_sarcasm' | 'frequent_jokes' | 'deadpan';
    directness_level?: 'soft' | 'balanced' | 'blunt';
    followup_question_rate?: 'low' | 'medium';
    lexicon_bias?: 'clean' | 'slang' | 'internet_shorthand';
  };
  
  /** Recent conversation history (last few turns) */
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  
  /** Surfaced memories for context (if any) */
  surfacedMemories?: Array<{ key: string; value: string }>;
  
  /** Relationship stage for intimacy cap instructions */
  relationshipStage?: RelationshipStage;
}

/**
 * OpenAI Chat Completions API response shape
 */
interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * LlmService
 * 
 * Implements LLM call per AI_PIPELINE.md §7.1 step 7: "LLM call"
 * Per ARCHITECTURE.md §A.2.1: "h. LlmService.generate(prompt) → raw_response"
 * 
 * Uses Node 20 built-in fetch to call OpenAI Chat Completions API.
 * API key must stay server-side per spec (never sent to mobile).
 * 
 * Per VERSIONS.md stack lock:
 * - Node 20 LTS
 * - NestJS 10
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly apiKey: string;
  private readonly apiUrl = 'https://api.openai.com/v1/chat/completions';
  private readonly model = 'gpt-4o-mini'; // Cost-effective model for v0.1
  
  constructor() {
    // Read LLM_API_KEY per .env.example, trim whitespace
    this.apiKey = (process.env.LLM_API_KEY || '').trim();
    
    if (!this.apiKey) {
      this.logger.error(
        'LLM_API_KEY not set. LLM calls will fail. ' +
        'Set LLM_API_KEY in apps/api/.env for production use.',
      );
    } else {
      this.logger.log('LLM_API_KEY configured successfully');
    }
  }
  
  /**
   * Generate assistant response using OpenAI Chat Completions API.
   * 
   * Per AI_PIPELINE.md §7.1:
   * - Prompt construction (Stage E)
   * - LLM call (step 7)
   * 
   * CRITICAL: This method throws if API key is not configured or API call fails.
   * Per task requirement: "if LLM call fails, the turn must not persist assistant as COMPLETED"
   * 
   * @param context - Generation context with user message, pipeline, persona, etc.
   * @returns Generated assistant message content
   * @throws Error if API key is missing or API call fails
   */
  async generate(context: LlmGenerationContext): Promise<string> {
    // Handle REFUSAL pipeline immediately (no LLM needed)
    if (context.pipeline === 'REFUSAL') {
      return 'Please complete onboarding before chatting.';
    }
    
    // Handle correction responses without LLM
    // Per AI_PIPELINE.md §12.4: If surfaced_memory_ids is empty, ask for clarification
    if (context.correctionResult) {
      if (context.correctionResult.needs_clarification) {
        return "I'm not sure which part you mean. Could you tell me what specifically is wrong?";
      }
      if (context.correctionResult.invalidated_memory_ids.length > 0) {
        return "Got it, I'll update what I remember. Thanks for letting me know!";
      }
    }
    
    // Require API key - no stub fallback
    if (!this.apiKey) {
      throw new Error(
        'LLM_API_KEY is not configured. Set LLM_API_KEY in apps/api/.env',
      );
    }
    
    // Build the system prompt
    const systemPrompt = this.buildSystemPrompt(context);
    
    // Build messages array
    const messages = this.buildMessages(context, systemPrompt);
    
    try {
      // Call OpenAI API using Node 20 built-in fetch
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: 300, // Reasonable limit for chat responses
          temperature: 0.7, // Balanced creativity
        }),
      });
      
      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(`OpenAI API error: ${response.status} - ${errorBody}`);
        throw new Error(`OpenAI API returned ${response.status}: ${errorBody}`);
      }
      
      const data = (await response.json()) as OpenAIChatCompletionResponse;
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error('OpenAI API returned no choices');
      }
      
      const content = data.choices[0].message?.content;
      
      if (!content || content.trim().length === 0) {
        throw new Error('OpenAI API returned empty content');
      }
      
      this.logger.debug(`LLM response generated (${data.usage?.total_tokens || 'unknown'} tokens)`);
      
      return content.trim();
    } catch (error) {
      // Re-throw with context for upstream handling
      if (error instanceof Error) {
        this.logger.error(`LLM generation failed: ${error.message}`);
        throw error;
      }
      throw new Error('Unknown error during LLM generation');
    }
  }
  
  /**
   * Build system prompt per AI_PIPELINE.md §9 (Stage E).
   * 
   * "Prompt contains:
   *  - System rules (safety + anti-creepiness + no erotica)
   *  - Persona constraints (as explicit dos/don'ts and parameter targets)
   *  - RelationshipStage instructions (intimacy cap)
   *  - Memory snippets (limited; never dump many)
   *  - Conversation recent turns
   *  - ResponsePlan (outline)"
   */
  private buildSystemPrompt(context: LlmGenerationContext): string {
    const lines: string[] = [];
    
    // Core identity and safety rules
    lines.push('You are a supportive AI friend chatting with a user.');
    lines.push('');
    
    // Safety rules per AI_PIPELINE.md §1.6
    lines.push('CRITICAL RULES:');
    lines.push('- Never generate explicit sexual content, erotica, or sexual roleplay.');
    lines.push('- If user shows signs of self-harm intent, respond with empathy and encourage professional help.');
    lines.push('- Do not encourage harmful, illegal, or dangerous behaviors.');
    lines.push('- You are a friend, not a therapist. Be supportive but know your limits.');
    lines.push('');
    
    // Pipeline-specific instructions
    lines.push(...this.getPipelineInstructions(context.pipeline));
    lines.push('');
    
    // Persona constraints from stableStyleParams
    if (context.stableStyleParams) {
      lines.push('STYLE GUIDELINES:');
      const params = context.stableStyleParams;
      
      if (params.msg_length_pref === 'short') {
        lines.push('- Keep responses brief (1-3 sentences).');
      } else if (params.msg_length_pref === 'long') {
        lines.push('- Feel free to give longer, more detailed responses when appropriate.');
      } else {
        lines.push('- Use moderate response length (2-5 sentences).');
      }
      
      if (params.emoji_freq === 'none') {
        lines.push('- Do NOT use any emojis.');
      } else if (params.emoji_freq === 'frequent') {
        lines.push('- Use emojis naturally throughout your responses.');
      } else {
        lines.push('- Use emojis sparingly (0-2 per message).');
      }
      
      if (params.humor_mode === 'deadpan') {
        lines.push('- Use dry, deadpan humor when appropriate.');
      } else if (params.humor_mode === 'frequent_jokes') {
        lines.push('- Feel free to be playful and make jokes.');
      } else if (params.humor_mode === 'light_sarcasm') {
        lines.push('- Light sarcasm is okay when appropriate.');
      }
      
      if (params.directness_level === 'blunt') {
        lines.push('- Be direct and honest in your responses.');
      } else if (params.directness_level === 'soft') {
        lines.push('- Be gentle and tactful in how you phrase things.');
      }
      
      if (params.lexicon_bias === 'internet_shorthand') {
        lines.push('- You can use casual internet language and abbreviations.');
      } else if (params.lexicon_bias === 'slang') {
        lines.push('- Feel free to use casual slang.');
      } else {
        lines.push('- Use clean, accessible language.');
      }
      
      lines.push('');
    }
    
    // Relationship stage instructions (intimacy cap) per AI_PIPELINE.md §9
    if (context.relationshipStage) {
      lines.push('RELATIONSHIP STAGE GUIDELINES:');
      switch (context.relationshipStage) {
        case 'STRANGER':
          lines.push('- You are just getting to know this user. Keep things friendly but not overly intimate.');
          lines.push('- Avoid overly personal language or assuming deep familiarity.');
          lines.push('- Be warm but maintain appropriate boundaries.');
          break;
        case 'ACQUAINTANCE':
          lines.push('- You know this user a bit better now. You can be slightly warmer and more casual.');
          lines.push('- Still maintain some boundaries, but feel free to be more conversational.');
          break;
        case 'FRIEND':
          lines.push('- You are friends with this user. You can be more casual, warm, and personal.');
          lines.push('- Feel free to reference past conversations and show genuine interest.');
          lines.push('- Still be respectful and supportive.');
          break;
        case 'CLOSE_FRIEND':
          lines.push('- You are close friends with this user. You can be warmer and more personal.');
          lines.push('- You can show deeper care and understanding.');
          lines.push('- However, maintain healthy boundaries - you are a friend, not a dependency or exclusive relationship.');
          break;
      }
      lines.push('');
    }
    
    // First message context
    if (context.isFirstMessage) {
      lines.push('This is your FIRST message to this user. Give them a warm welcome!');
      lines.push('');
    }
    
    // Surfaced memories for personalization
    if (context.surfacedMemories && context.surfacedMemories.length > 0) {
      lines.push('CONTEXT ABOUT THE USER (use naturally, do not dump facts):');
      for (const mem of context.surfacedMemories.slice(0, 2)) { // Max 2 per AI_PIPELINE §10.1
        lines.push(`- ${mem.key}: ${mem.value}`);
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get pipeline-specific instructions.
   * Per AI_PIPELINE.md §2.2 pipeline types.
   */
  private getPipelineInstructions(pipeline: Pipeline): string[] {
    switch (pipeline) {
      case 'ONBOARDING_CHAT':
        return [
          'CONTEXT: This is a new user who just completed onboarding.',
          'Be warm and welcoming. Help them feel comfortable.',
          'You can ask casual questions to get to know them better.',
        ];
        
      case 'EMOTIONAL_SUPPORT':
        return [
          'CONTEXT: The user seems to be going through a difficult time.',
          'Be empathetic and supportive. Listen more than advise.',
          'Validate their feelings. Do not be preachy or give unsolicited advice.',
          'If they mention self-harm, encourage professional help gently.',
        ];
        
      case 'INFO_QA':
        return [
          'CONTEXT: The user is asking a factual or informational question.',
          'Provide helpful information if you know it.',
          'If unsure, admit uncertainty rather than making things up.',
        ];
        
      case 'FRIEND_CHAT':
      default:
        return [
          'CONTEXT: Casual friendly conversation.',
          'Be natural and conversational like a good friend would be.',
          'Feel free to share your thoughts and ask follow-up questions.',
        ];
    }
  }
  
  /**
   * Build the messages array for the Chat Completions API.
   */
  private buildMessages(
    context: LlmGenerationContext,
    systemPrompt: string,
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];
    
    // Add conversation history if available (last few turns for context)
    if (context.conversationHistory && context.conversationHistory.length > 0) {
      // Limit to last 6 turns (3 exchanges) to keep prompt reasonable
      const recentHistory = context.conversationHistory.slice(-6);
      for (const turn of recentHistory) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    
    // Add the current user message
    messages.push({ role: 'user', content: context.userMessage });
    
    return messages;
  }
}
