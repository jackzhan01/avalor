/**
 * Calling the provider straight from the browser, with the user's own key.
 *
 * This is the BYOK path. It duplicates a little of what `/api/ai` does, and
 * that duplication is on purpose: the two paths have genuinely different jobs.
 * The server route holds OUR key, so it has to gate access and meter spend;
 * this one holds nobody's key but the user's, so it does neither — there is no
 * budget of ours to protect and no one to bill.
 *
 * OpenAI's API answers CORS preflights (`access-control-allow-headers:
 * authorization`), which is what makes this possible at all. A provider that
 * doesn't will fail with a network error, and `describeFailure` says so rather
 * than blaming the key.
 */

import type { ByokConfig } from "./byok";
import { DEFAULT_BASE_URL } from "./byok";

const TIMEOUT_MS = 60_000;

function endpoint(config: ByokConfig, path: string): string {
  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}${path}`;
}

/** Maps a provider's HTTP status to something worth reading mid-game. */
function describeStatus(status: number, detail: string): string {
  const suffix = detail ? `：${detail.slice(0, 200)}` : "";
  if (status === 401) return "这个 key 不被接受（401），检查一下有没有复制全、或者是不是已经撤销了。";
  if (status === 403) return `这个 key 没有权限调用这个模型（403）${suffix}`;
  if (status === 404) return `找不到这个模型（404），换一个模型名试试${suffix}`;
  if (status === 429) return "被限流或者额度用完了（429），等一会儿再试，或者去后台看看余额。";
  if (status >= 500) return `模型服务自己出问题了（${status}）${suffix}`;
  return `模型服务返回了 ${status}${suffix}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? "";
  } catch {
    return "";
  }
}

function describeFailure(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") {
    return "模型响应超时了，再试一次。";
  }
  // A browser-side fetch that throws is almost always CORS or offline, and the
  // two are indistinguishable from here by design (the browser hides which).
  return "连不上模型服务。可能是断网了，也可能是这个服务不允许浏览器直连 —— 换回用我们的额度试试。";
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the provider whether this key can see this model.
 *
 * A GET on the model costs nothing and consumes no tokens, which is what makes
 * it usable as a "Test" button — the user finds out their setup works without
 * paying for a full analysis to discover it doesn't.
 */
export async function testByok(config: ByokConfig): Promise<void> {
  let response: Response;
  try {
    response = await withTimeout((signal) =>
      fetch(endpoint(config, `/models/${encodeURIComponent(config.model)}`), {
        headers: { Authorization: `Bearer ${config.key}` },
        signal,
      }),
    );
  } catch (err) {
    throw new Error(describeFailure(err));
  }

  if (!response.ok) {
    throw new Error(describeStatus(response.status, await readError(response)));
  }
}

/** One chat completion. Returns the raw message content for `parse.ts`. */
export async function completeDirect(
  config: ByokConfig,
  system: string,
  user: string,
): Promise<string> {
  let response: Response;
  try {
    response = await withTimeout((signal) =>
      fetch(endpoint(config, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.key}`,
        },
        // Same minimal body as the server route, for the same reason: every
        // optional knob is a place where providers disagree.
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
        }),
        signal,
      }),
    );
  } catch (err) {
    throw new Error(describeFailure(err));
  }

  if (!response.ok) {
    throw new Error(describeStatus(response.status, await readError(response)));
  }

  try {
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
  } catch {
    throw new Error("模型返回的内容读不出来。");
  }
}
