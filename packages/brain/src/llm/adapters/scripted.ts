/**
 * Scripted LLM provider — a deterministic, canned-response stand-in for a real
 * model, for E2E and dev. It replays a fixture of rules instead of calling a
 * cloud LLM, so a test can drive the REAL agentic path (ask, remember, Tier-1
 * service answers) with zero cost and a fixed output. NEVER a production
 * provider (the brain-server only builds it under an explicit env opt-in).
 *
 * A rule matches when its (case-insensitive) `match` substring appears in the
 * system prompt + the concatenated message text; the FIRST match wins. An empty
 * `match` always matches — put it last as the fallback. `strict` (default true)
 * throws when nothing matches, so a missing rule surfaces as a test failure
 * rather than a silent empty answer.
 */

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  EmbedOptions,
  EmbedResponse,
  LLMProvider,
  StreamChunk,
  ToolCall,
} from './provider';

export interface ScriptedRule {
  /** Case-insensitive substring matched against the system prompt + all message
   *  contents. Empty string = always matches (use as the fallback, last rule). */
  match: string;
  /** The content the model returns (often JSON for a Tier-1 capability answer). */
  content: string;
  /** Optional tool calls, for scripting an agentic (tool-using) turn. */
  toolCalls?: ToolCall[];
}

export interface ScriptedProviderOptions {
  rules: ScriptedRule[];
  /** Throw when no rule matches (default true — a missing rule is a test bug). */
  strict?: boolean;
}

function haystackFor(messages: ChatMessage[], options?: ChatOptions): string {
  const parts = [options?.systemPrompt ?? '', ...messages.map((m) => m.content ?? '')];
  return parts.join('\n').toLowerCase();
}

export class ScriptedLLMProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly supportsStreaming = false;
  readonly supportsToolCalling = true;
  readonly supportsEmbedding = false;

  private readonly rules: ScriptedRule[];
  private readonly strict: boolean;

  constructor(opts: ScriptedProviderOptions) {
    this.rules = opts.rules;
    this.strict = opts.strict ?? true;
  }

  private match(messages: ChatMessage[], options?: ChatOptions): ScriptedRule | undefined {
    const haystack = haystackFor(messages, options);
    return this.rules.find((r) => r.match === '' || haystack.includes(r.match.toLowerCase()));
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const rule = this.match(messages, options);
    if (rule === undefined) {
      if (this.strict) {
        throw new Error(
          'ScriptedLLMProvider: no rule matched this request (add a rule, or an empty-match fallback)',
        );
      }
      return {
        content: '{}',
        toolCalls: [],
        model: 'scripted',
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'end',
      };
    }
    const toolCalls = rule.toolCalls ?? [];
    return {
      content: rule.content,
      toolCalls,
      model: 'scripted',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'end',
    };
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('ScriptedLLMProvider: streaming is not supported');
  }

  async embed(_text: string, _options?: EmbedOptions): Promise<EmbedResponse> {
    // Embeddings come from the runtime's separate embedding provider (the
    // brain-server pairs scripted chat with a deterministic embedder), never
    // from here — keep this fail-loud so a stray call is caught.
    throw new Error('ScriptedLLMProvider: embed is not supported (use a dedicated embedder)');
  }
}

/** Build a scripted provider from a plain rules array. */
export function buildScriptedProvider(opts: ScriptedProviderOptions): ScriptedLLMProvider {
  return new ScriptedLLMProvider(opts);
}
