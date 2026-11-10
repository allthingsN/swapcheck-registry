import type { SourceDef } from "../src/types.ts";
import { anthropic } from "./anthropic.ts";
import { azure } from "./azure.ts";
import { bedrock } from "./bedrock.ts";
import { cohere } from "./cohere.ts";
import { deepseek } from "./deepseek.ts";
import { deprecationsInfo } from "./deprecations-info.ts";
import { gemini } from "./gemini.ts";
import { groq } from "./groq.ts";
import { litellm } from "./litellm.ts";
import { mistral } from "./mistral.ts";
import { modelsDev } from "./models-dev.ts";
import { openai } from "./openai.ts";
import { openrouter } from "./openrouter.ts";
import { together } from "./together.ts";
import { vertex } from "./vertex.ts";
import { xai } from "./xai.ts";

/** Order matters only for readability; consolidation is independent of it. */
export const SOURCES: SourceDef[] = [
  anthropic, gemini, openai, bedrock, vertex, azure, mistral, xai, cohere, groq, deepseek, together,
  modelsDev, openrouter, litellm, deprecationsInfo,
];
