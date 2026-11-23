import type { AppConfig, ModelConfig, Protocol, ProviderConfig } from "../bridge";

/**
 * 引导页的服务方预设：选一张卡片，地址、协议、推荐模型、能不能看图都填好，
 * 用户只需要粘贴 key。
 *
 * `[约束]` 模型名会过时。这里只放「选它时的默认值」，引导页上模型名始终可改，
 * 也可以从服务方拉清单（`listModels`）。改这张表时，地址按 riot-providers 的
 * `api_url` 规则写：只有主机名会自动补 `/v1`，带了路径就原样接 —— 所以
 * 通义千问必须写到 `/compatible-mode/v1`，智谱写到 `/api/paas/v4`。
 */
export interface ProviderPreset {
  id: string;
  /** 卡片上的名字。 */
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** key 存在 auth.json 的这个名字下（同名环境变量优先）。 */
  apiKeyEnv: string;
  /** 推荐的主模型。空 = 让用户自己填或从服务方拉。 */
  model: string;
  /** 推荐主模型能不能看图。 */
  vision: boolean;
  /** 同一家的视觉模型（主模型看不了图时，视觉兼容优先推荐它，复用同一个 key）。 */
  visionModel?: string;
  /** 去哪里申请 key。 */
  keyUrl?: string;
  /** 不需要 key（本地 Ollama）。 */
  noKey?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-5-5",
    vision: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-5",
    vision: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-pro",
    vision: false,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    model: "glm-5.2",
    vision: false,
    visionModel: "glm-4.6v",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "qwen",
    name: "Qwen",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    model: "qwen-max",
    vision: false,
    visionModel: "qwen-vl-max",
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    id: "ollama",
    name: "Ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434",
    apiKeyEnv: "OLLAMA_API_KEY",
    model: "",
    vision: false,
    noKey: true,
  },
  {
    id: "custom",
    name: "",
    protocol: "openai",
    baseUrl: "",
    apiKeyEnv: "CUSTOM_API_KEY",
    model: "",
    vision: false,
  },
];

/** 视觉兼容「快速添加」能选的：本身能看图的预设，加上有视觉模型的那几家。 */
export function visionPresets(): { preset: ProviderPreset; model: string }[] {
  return PROVIDER_PRESETS.flatMap((p) => {
    if (p.visionModel) return [{ preset: p, model: p.visionModel }];
    if (p.vision && p.model) return [{ preset: p, model: p.model }];
    return [];
  });
}

/** 不和已有 id 撞名的服务方 id。同一家加第二次时带序号。 */
export function uniqueProviderId(base: string, cfg: AppConfig): string {
  const taken = new Set(cfg.providers.map((p) => p.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

/** 按预设和用户填的东西拼出一个服务方配置。 */
export function providerFromPreset(
  preset: ProviderPreset,
  id: string,
  fields: { name?: string; baseUrl?: string; models: ModelConfig[] },
): ProviderConfig {
  return {
    id,
    name: fields.name?.trim() || preset.name || id,
    protocol: preset.protocol,
    baseUrl: (fields.baseUrl ?? preset.baseUrl).trim(),
    // 同一家加第二次时 key 名也要分开，否则两份 key 互相覆盖。
    apiKeyEnv: id === preset.id ? preset.apiKeyEnv : `${preset.apiKeyEnv}_${id.split("-").pop()}`,
    models: fields.models,
    fallbackModel: null,
    sampling: {},
  };
}

/** 配置里所有能看图的模型，`providerId/model` 形式（视觉兼容的取值）。 */
export function visionCandidates(cfg: AppConfig): { value: string; label: string }[] {
  return cfg.providers.flatMap((p) =>
    p.models
      .filter((m) => m.vision)
      .map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.name} · ${m.name || m.id}` })),
  );
}

/** 当前主模型的配置。 */
export function activeModelConfig(cfg: AppConfig): ModelConfig | undefined {
  return cfg.providers.find((p) => p.id === cfg.activeProvider)?.models.find((m) => m.id === cfg.activeModel);
}
