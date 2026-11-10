/** Maps a model ID to the company that makes it. Pattern order matters: most specific first. */
const PATTERNS: Array<[RegExp, string]> = [
  [/(^|[./])(anthropic|claude)/i, "anthropic"],
  [/(^|[./-])(gpt-oss|whisper|openai|^o\d|gpt-)/i, "openai"],
  [/(^|[./])(google|gemini|gemma|veo|imagen)/i, "google"],
  [/(^|[./])(meta|llama|meta-llama|muse-spark)/i, "meta"],
  [/(^|[./])(qwen|alibaba|tongyi)/i, "alibaba"],
  [/(^|[./])deepseek/i, "deepseek"],
  [/(^|[./])(mistral|mixtral|magistral|codestral|devstral|pixtral|ministral|voxtral)/i, "mistral"],
  [/(^|[./])(moonshot|kimi)/i, "moonshot"],
  [/(^|[./])(x-ai|xai|grok)/i, "xai"],
  [/(^|[./])(cohere|command|embed-|rerank)/i, "cohere"],
  [/(^|[./])(amazon|nova|titan)/i, "amazon"],
  [/(^|[./])(minimax)/i, "minimax"],
  [/(^|[./])(z-ai|zai|glm|zhipu)/i, "zhipu"],
  [/(^|[./])(nvidia|nemotron)/i, "nvidia"],
  [/(^|[./])(thinkingmachines|inkling)/i, "thinkingmachines"],
  [/(^|[./])(microsoft|phi-)/i, "microsoft"],
  [/(^|[./])(ai21|jamba)/i, "ai21"],
  [/(^|[./])(bytedance|seed)/i, "bytedance"],
  [/(^|[./])(black-forest-labs|flux)/i, "black-forest-labs"],
  [/(^|[./])(stability|stable-)/i, "stability"],
  [/(^|[./])(playai)/i, "playai"],
];

/** Vendor for a hosted model ID, falling back to the platform's own name. */
export function vendorFor(modelId: string, fallback: string): string {
  for (const [pattern, vendor] of PATTERNS) {
    if (pattern.test(modelId)) return vendor;
  }
  return fallback;
}

const NAMED_VENDORS: Array<[RegExp, string]> = [
  [/^AI21/i, "ai21"],
  [/^Azure OpenAI|^OpenAI/i, "openai"],
  [/^Anthropic/i, "anthropic"],
  [/^Black Forest/i, "black-forest-labs"],
  [/^Cohere/i, "cohere"],
  [/^DeepSeek/i, "deepseek"],
  [/^Fireworks/i, "fireworks"],
  [/^Google/i, "google"],
  [/^Meta/i, "meta"],
  [/^Microsoft/i, "microsoft"],
  [/^MiniMax/i, "minimax"],
  [/^Mistral/i, "mistral"],
  [/^Moonshot/i, "moonshot"],
  [/^Nixtla/i, "nixtla"],
  [/^NTT/i, "ntt-data"],
  [/^Qwen/i, "alibaba"],
  [/^Stability/i, "stability"],
  [/^xAI/i, "xai"],
];

/** Vendor from a provider name printed on a page, e.g. a Bedrock or Azure heading. */
export function vendorFromName(name: string, fallback: string): string {
  for (const [pattern, vendor] of NAMED_VENDORS) {
    if (pattern.test(name.trim())) return vendor;
  }
  return fallback;
}
