export type LocalProviderCapability = "image" | "video" | "text" | "audio";

export type LocalProviderModel = {
    name: string;
    capability: LocalProviderCapability;
};

export const XG_CHANNEL_ID = "xg";
export const XG_PROXY_PATH = "/xg-api";
export const XG_IMAGE_MODELS = ["gpt-image-2"] as const;
export const XG_TEXT_MODELS = ["auto"] as const;
export const XG_MODELS: LocalProviderModel[] = [...XG_IMAGE_MODELS.map((name) => ({ name, capability: "image" as const })), ...XG_TEXT_MODELS.map((name) => ({ name, capability: "text" as const }))];

export const MINIMAX_CHANNEL_ID = "minimax";
export const MINIMAX_BASE_URL = "https://api.minimaxi.com";
export const MINIMAX_TEXT_MODELS = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2", "M2-her"] as const;
export const MINIMAX_IMAGE_MODELS = ["image-01", "image-01-live"] as const;
export const MINIMAX_VIDEO_MODELS = ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02", "T2V-01-Director", "T2V-01", "I2V-01-Director", "I2V-01-live", "I2V-01"] as const;
export const MINIMAX_AUDIO_MODELS = ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo"] as const;
export const MINIMAX_MODELS: LocalProviderModel[] = [
    ...MINIMAX_TEXT_MODELS.map((name) => ({ name, capability: "text" as const })),
    ...MINIMAX_IMAGE_MODELS.map((name) => ({ name, capability: "image" as const })),
    ...MINIMAX_VIDEO_MODELS.map((name) => ({ name, capability: "video" as const })),
    ...MINIMAX_AUDIO_MODELS.map((name) => ({ name, capability: "audio" as const })),
];
export const MINIMAX_MODEL_NAMES = MINIMAX_MODELS.map((model) => model.name);

export const LEGACY_BRIDGE_MODELS = ["ChatGPT Bridge Image 02", "ChatGPT Workflow Instant", "ChatGPT Workflow Low", "ChatGPT Workflow Medium", "ChatGPT Workflow High", "ChatGPT Workflow XHigh", "ChatGPT Workflow Pro"] as const;

export function localWebProxyBaseUrl(path: string) {
    const origin = typeof window === "undefined" ? "http://127.0.0.1:3000" : window.location.origin;
    return `${origin}${path}`;
}
