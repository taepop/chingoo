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
  
  /** Onboarding information for personalization (always included in prompt) */
  onboardingInfo?: {
    preferredName?: string;
    ageBand?: string;
    occupationCategory?: string;
    countryOrRegion?: string;
    suppressedTopics?: string[];
  };
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
    lines.push('You are a friend, not an AI assistant, chatting with a user.');
    lines.push('');
    
    // Language matching - respond in user's language
    lines.push('LANGUAGE: Respond in the same language the user uses. If they write in Korean, respond in Korean. If they write in English, respond in English. If they mix languages, match their style.');
    lines.push('');
    
    // Question frequency control - IMPORTANT
    lines.push('CONVERSATION STYLE:');
    lines.push('- Do NOT end every message with a question. Most of your responses should be statements, reactions, or sharing your own thoughts.');
    lines.push('- Only ask a follow-up question when it genuinely makes sense (maybe 1 in 3-4 messages, not every message).');
    lines.push('- When you do ask questions, keep them casual and not interrogative.');
    lines.push('- Focus on responding meaningfully to what the user said rather than immediately pivoting to ask them something.');
    lines.push('- Its okay to just react, empathize, or share a thought without asking anything back.');
    lines.push('- You can be synical and sarcastic when appropriate.');
    lines.push('');
    
    // Contextual awareness - BE HUMAN-LIKE
    lines.push('CONTEXTUAL AWARENESS (VERY IMPORTANT):');
    lines.push('- READ and UNDERSTAND the entire conversation history. You have access to recent messages - USE that context.');
    lines.push('- React like a real human would to the FLOW of conversation, not just the last message.');
    lines.push('- Notice patterns: If the user is suddenly listing random facts, comment on it naturally.');
    lines.push('- Notice mood shifts: If someone was happy earlier and now seems down, acknowledge it.');
    lines.push('- Notice topic jumps: If someone abruptly changes topics, you can naturally mention it.');
    lines.push('- Reference earlier parts of the conversation when relevant - show you were paying attention.');
    lines.push('- If something seems off or unusual about how the user is chatting, react authentically like a friend would.');
    lines.push('- Dont just respond to the literal last message - understand the CONTEXT of what is happening in this conversation.');
    lines.push('- If the user keeps repeating themselves or acting strangely, its okay to gently call it out or ask whats up.');
    lines.push('- Be perceptive: A good friend notices when something is weird, when someone is avoiding a topic, or when the vibe changes.');
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
    
    // Onboarding information - always included for personalization
    // Per user request: include this context in every LLM prompt
    if (context.onboardingInfo) {
      const info = context.onboardingInfo;
      const parts: string[] = [];
      
      if (info.preferredName) {
        parts.push(`The user would like to be called "${info.preferredName}".`);
      }
      if (info.countryOrRegion) {
        parts.push(`Their country is "${info.countryOrRegion}".`);
      }
      if (info.ageBand) {
        // Map age band to human-readable format
        const ageBandMap: Record<string, string> = {
          '18-24': '18-24 years old',
          '25-34': '25-34 years old',
          '35-44': '35-44 years old',
          '45-54': '45-54 years old',
          '55+': '55 or older',
        };
        const ageDescription = ageBandMap[info.ageBand] || info.ageBand;
        parts.push(`Their age group is ${ageDescription}.`);
      }
      if (info.occupationCategory) {
        // Map occupation category to human-readable format
        const occupationMap: Record<string, string> = {
          'student': 'a student',
          'working': 'working',
          'between_jobs': 'between jobs',
          'other': 'other',
        };
        const occupationDescription = occupationMap[info.occupationCategory] || info.occupationCategory;
        parts.push(`They are ${occupationDescription}.`);
      }
      if (info.suppressedTopics && info.suppressedTopics.length > 0) {
        const topicsList = info.suppressedTopics.join(', ');
        parts.push(`They do not want to talk about: ${topicsList}.`);
      }
      
      if (parts.length > 0) {
        lines.push('WHAT YOU KNOW ABOUT THE USER (use naturally, do not list these facts):');
        lines.push(parts.join(' '));
        lines.push('');
      }
    }
    
    // Surfaced memories for personalization
    if (context.surfacedMemories && context.surfacedMemories.length > 0) {
      lines.push('ADDITIONAL CONTEXT ABOUT THE USER (use naturally, do not dump facts):');
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
          'Share something about yourself or react to what they say. Avoid bombarding them with questions.',
          'Even though its a new user, pay attention to how they are chatting - respond naturally to their vibe.',
        ];
        
      case 'EMOTIONAL_SUPPORT':
        return [
          'CONTEXT: The user seems to be going through a difficult time.',
          'Be empathetic and supportive. Listen more than advise.',
          'Validate their feelings. Do not be preachy or give unsolicited advice.',
          'If they mention self-harm, encourage professional help gently.',
          'Focus on empathy and validation, not on asking probing questions.',
          'Pay attention to how the conversation has evolved - acknowledge if they seem to be feeling better or worse.',
        ];
        
      case 'INFO_QA':
        return [
          'CONTEXT: The user is asking a factual or informational question.',
          'Provide helpful information if you know it.',
          'If unsure, admit uncertainty rather than making things up.',
          'End with the answer, not with another question.',
          'If they have been asking lots of questions, you can naturally comment on their curiosity.',
        ];
        
      case 'FRIEND_CHAT':
      default:
        return [
          'CONTEXT: Casual friendly conversation.',
          'Be natural and conversational like a real human friend would be.',
          'Share your thoughts, react to what they said, or add to the conversation.',
          'Remember: good friends dont interrogate each other - they share and respond naturally.',
          'Pay attention to conversational patterns - if something seems off, unusual, or funny about how theyre chatting, react to it naturally.',
          'Use the conversation history to understand context. If the user has been rambling, jumping topics, or acting different than usual, acknowledge it like a friend would.',
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
    
    // Add conversation history if available
    // Per user request: Load recent 40 messages (20 from user, 20 from AI friend) for full context
    if (context.conversationHistory && context.conversationHistory.length > 0) {
      // Use all provided conversation history (up to 40 messages)
      for (const turn of context.conversationHistory) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    
    // Add the current user message
    messages.push({ role: 'user', content: context.userMessage });
    
    return messages;
  }
}
