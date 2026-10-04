// Chat providers — mirror of ChatProvider in IslandTypes.swift. Ids, names,
// colours and default models match the Mac so settings read the same.

import type { Settings } from "./state";

export type ChatProviderId = "anthropic" | "google" | "openai" | "ollama" | "lmstudio";

type ModelField = "model" | "googleModel" | "openaiModel" | "ollamaModel" | "lmstudioModel";

export interface ChatProvider {
  id: ChatProviderId;
  name: string;
  accent: string;
  /** Empty for local servers: their model has to be picked. */
  defaultModel: string;
  /** Settings field holding the chosen model. */
  modelField: ModelField;
  /** Keychain entry; optional for local servers. */
  key: string;
  /** Settings field holding the server URL, for local providers. */
  urlField: "ollamaUrl" | "lmstudioUrl" | null;
}

export const CHAT_PROVIDERS: ChatProvider[] = [
  { id: "anthropic", name: "Anthropic", accent: "#E07950", defaultModel: "claude-opus-5",
    modelField: "model", key: "anthropic-api-key", urlField: null },
  { id: "google", name: "Google", accent: "#4285F4", defaultModel: "gemini-2.0-flash",
    modelField: "googleModel", key: "google-api-key", urlField: null },
  { id: "openai", name: "OpenAI", accent: "#10A37F", defaultModel: "gpt-4o",
    modelField: "openaiModel", key: "openai-api-key", urlField: null },
  { id: "ollama", name: "Ollama", accent: "#FACC15", defaultModel: "",
    modelField: "ollamaModel", key: "ollama-api-key", urlField: "ollamaUrl" },
  { id: "lmstudio", name: "LM Studio", accent: "#A3E635", defaultModel: "",
    modelField: "lmstudioModel", key: "lmstudio-api-key", urlField: "lmstudioUrl" },
];

export function providerById(id: string): ChatProvider {
  return CHAT_PROVIDERS.find((p) => p.id === id) ?? CHAT_PROVIDERS[0];
}

export function activeProvider(settings: Settings): ChatProvider {
  return providerById(settings.chatProvider);
}

export function modelFor(settings: Settings, provider: ChatProvider): string {
  return settings[provider.modelField].trim() || provider.defaultModel;
}

/** Local providers only show up once their server is connected, or while in use. */
export function providerVisible(settings: Settings, provider: ChatProvider): boolean {
  if (!provider.urlField) return true;
  return settings[provider.urlField] !== "" || settings.chatProvider === provider.id;
}
