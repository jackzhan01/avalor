/**
 * Bring Your Own Key.
 *
 * The user pastes their own API key and the AI features run on their quota
 * instead of ours. The interesting decision is not storage, it is ROUTING:
 * a request made with the user's key goes from THEIR BROWSER STRAIGHT TO THE
 * PROVIDER. Our server is not in the path at all.
 *
 * That is deliberate, and it is the whole point. "We promise not to read your
 * key" is a sentence; "the key is never sent to a machine we control" is a
 * fact anyone can verify in the network tab. This app already prefers the
 * second kind of guarantee everywhere else — the private layer is a separate
 * event type rather than a promise to filter carefully — so it would be odd to
 * hold a credential to a weaker standard than a role mark.
 *
 * The trade is real and worth stating: a key in localStorage is readable by
 * any script that runs on this origin. That is why the UI says so plainly and
 * why this is opt-in. The alternative — us holding it server-side — moves the
 * risk from "this device" to "our database", which is strictly worse for the
 * user and worse for us.
 */

const STORAGE_KEY = "avalor.ai.byok.v1";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ByokConfig {
  key: string;
  /** Their key, their choice of model — ours may not be one they can call. */
  model: string;
  /** Any OpenAI-compatible endpoint. Empty means the OpenAI default. */
  baseUrl?: string;
}

/** null when nothing is stored, storage is unavailable, or the blob is junk. */
export function loadByok(): ByokConfig | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode / storage disabled
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ByokConfig>;
    if (typeof parsed.key !== "string" || parsed.key.length === 0) return null;
    return {
      key: parsed.key,
      model:
        typeof parsed.model === "string" && parsed.model.trim()
          ? parsed.model.trim()
          : DEFAULT_MODEL,
      ...(typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? { baseUrl: parsed.baseUrl.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveByok(config: ByokConfig): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        key: config.key.trim(),
        model: config.model.trim() || DEFAULT_MODEL,
        ...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
      }),
    );
  } catch {
    /* storage full or disabled — the caller re-reads and sees it didn't take */
  }
}

export function clearByok(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — there is no other copy of it anywhere */
  }
}

/**
 * Deliberately loose. It rejects what is certainly not a key — blank, spaces
 * in the middle, a pasted whole curl command — and nothing else, because
 * OpenAI-compatible providers issue keys in every shape imaginable and a
 * regex that demands `sk-` would lock out DeepSeek, Qwen and self-hosted vLLM
 * for no gain. The real check is the Test button, which asks the provider.
 */
export function validateKey(key: string): string | null {
  const text = key.trim();
  if (!text) return "还没填 key。";
  if (/\s/.test(text)) return "key 里不该有空格或换行，检查一下是不是多复制了东西。";
  if (text.length < 20) return "这个 key 看起来太短了，是不是没复制全？";
  return null;
}

/** "sk-proj-abcd…wX9A" — enough to recognise, not enough to use. */
export function maskKey(key: string): string {
  const text = key.trim();
  if (text.length <= 12) return "•".repeat(text.length);
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}
