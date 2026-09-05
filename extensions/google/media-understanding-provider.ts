// Google provider module implements model/runtime integration.
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
  VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowProviderError,
  postJsonRequest,
  readProviderJsonResponse,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiHttpRequestConfig,
} from "./runtime-api.js";

const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

async function generateGeminiInlineDataText(params: {
  buffer: Buffer;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultPrompt: string;
  defaultMime: string;
  httpErrorLabel: string;
  missingTextError: string;
}): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = (() => {
    const trimmed = params.model?.trim();
    if (!trimmed) {
      return params.defaultModel;
    }
    return normalizeGoogleModelId(trimmed);
  })();
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      headers: params.headers,
      request: params.request,
      capability: params.defaultMime.startsWith("audio/") ? "audio" : "video",
      transport: "media-understanding",
    });
  const resolvedBaseUrl = baseUrl ?? params.defaultBaseUrl;
  const url = `${resolvedBaseUrl}/models/${model}:generateContent`;

  const prompt = (() => {
    const trimmed = params.prompt?.trim();
    return trimmed || params.defaultPrompt;
  })();
  // Agentic navigation is an explicit Gemini video Part contract, not a model default.
  // https://ai.google.dev/gemini-api/docs/generate-content/video-understanding#agentic-video-understanding
  const agenticVideo = params.defaultMime.startsWith("video/") && model === "gemini-3.8-flash";

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: params.mime ?? params.defaultMime,
              data: params.buffer.toString("base64"),
            },
            ...(agenticVideo ? { mediaProcessing: "AGENTIC" } : {}),
          },
        ],
      },
    ],
  };

  const { response: res, release } = await postJsonRequest({
    url,
    headers,
    body,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowProviderError(res, params.httpErrorLabel);

    const payload = await readProviderJsonResponse<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
            toolCall?: { toolType?: string };
            toolResponse?: { toolType?: string };
          }>;
        };
      }>;
    }>(res, params.httpErrorLabel);
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part?.text?.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) {
      throw new Error(params.missingTextError);
    }
    return {
      text,
      model,
      ...(agenticVideo
        ? {
            processing: {
              mode: "agentic",
              verified:
                parts.some((part) => part.toolCall?.toolType === "MEDIA_PROCESSING") &&
                parts.some((part) => part.toolResponse?.toolType === "MEDIA_PROCESSING"),
            },
          }
        : {}),
    };
  } finally {
    await release();
  }
}

export async function transcribeGeminiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    defaultModel: DEFAULT_GOOGLE_AUDIO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_AUDIO_PROMPT,
    defaultMime: "audio/wav",
    httpErrorLabel: "Audio transcription failed",
    missingTextError: "Audio transcription response missing text",
  });
  return { text, model };
}

export async function describeGeminiVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  return await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
    defaultMime: "video/mp4",
    httpErrorLabel: "Video description failed",
    missingTextError: "Video description response missing text",
  });
}

export const googleMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "google",
  capabilities: ["image", "audio", "video"],
  defaultModels: {
    image: DEFAULT_GOOGLE_VIDEO_MODEL,
    audio: DEFAULT_GOOGLE_AUDIO_MODEL,
    video: DEFAULT_GOOGLE_VIDEO_MODEL,
  },
  autoPriority: { image: 30, audio: 40, video: 10 },
  nativeDocumentInputs: ["pdf"],
  describeImage: undefined,
  describeImages: undefined,
  transcribeAudio: transcribeGeminiAudio,
  describeVideo: describeGeminiVideo,
};
