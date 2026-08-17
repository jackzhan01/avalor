"use client";

import { useEffect, useState } from "react";
import { ListGroup, ListAction, ListRow } from "@/components/ui/list";
import { Button } from "@/components/ui/button";
import { InlineWarning } from "@/components/ui/feedback";
import {
  clearByok,
  loadByok,
  maskKey,
  saveByok,
  validateKey,
  DEFAULT_MODEL,
  type ByokConfig,
} from "@/lib/ai/byok";
import { testByok } from "@/lib/ai/direct";
import { useHydrated } from "@/lib/store/hooks";

/**
 * "Use my own API key."
 *
 * The copy here is doing real work, so it is worth being careful about. A user
 * pasting a credential deserves to know three things before they do it, and
 * all three are stated on screen rather than buried in a privacy page: where
 * the key is kept, who the request goes to, and what happens if this device is
 * not only theirs.
 *
 * The claim "it never touches our servers" is not a policy here — it is a
 * consequence of `client.ts` calling the provider directly whenever a key is
 * stored. Anyone can confirm it in the network tab, which is the only kind of
 * privacy claim worth making.
 */
export function ApiKeyCard() {
  const hydrated = useHydrated();
  const [saved, setSaved] = useState<ByokConfig | null>(null);
  const [editing, setEditing] = useState(false);

  const [key, setKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "ok">("idle");

  // localStorage is unreadable until the client has hydrated, so the stored
  // config can only be picked up here — not during the first render.
  useEffect(() => {
    if (hydrated) setSaved(loadByok());
  }, [hydrated]);

  function startEditing() {
    const current = loadByok();
    setKey(current?.key ?? "");
    setModel(current?.model ?? DEFAULT_MODEL);
    setBaseUrl(current?.baseUrl ?? "");
    setError("");
    setStatus("idle");
    setEditing(true);
  }

  function draft(): ByokConfig {
    return {
      key: key.trim(),
      model: model.trim() || DEFAULT_MODEL,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    };
  }

  async function test() {
    const problem = validateKey(key);
    if (problem) {
      setError(problem);
      setStatus("idle");
      return;
    }
    setError("");
    setStatus("testing");
    try {
      await testByok(draft());
      setStatus("ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败。");
      setStatus("idle");
    }
  }

  function save() {
    const problem = validateKey(key);
    if (problem) {
      setError(problem);
      return;
    }
    const config = draft();
    saveByok(config);
    setSaved(config);
    setEditing(false);
    setKey("");
  }

  /* ── Saved, not editing ──────────────────────────────────────────────── */

  if (!editing) {
    return (
      <ListGroup
        header="AI 用谁的额度"
        footer={
          saved
            ? "分析请求由这台设备直接发给模型服务商，不经过我们的服务器 —— 我们看不到你的 key，也看不到你的对局。"
            : "填上自己的 key，就用你自己的额度，请求也不再经过我们。"
        }
      >
        {saved ? (
          <>
            <ListRow
              label="用我自己的 key"
              detail={maskKey(saved.key)}
              value="已启用"
            />
            <ListRow label="模型" value={saved.model} />
            {saved.baseUrl && <ListRow label="接口地址" value={saved.baseUrl} />}
            <ListAction label="改一下" onClick={startEditing} />
            <ListAction
              label="删掉这个 key"
              destructive
              onClick={() => {
                clearByok();
                setSaved(null);
              }}
            />
          </>
        ) : (
          <>
            <ListRow
              label="用我们的额度"
              detail="需要登录，有每日次数上限"
              value="当前"
            />
            <ListAction label="改用我自己的 API key" onClick={startEditing} />
          </>
        )}
      </ListGroup>
    );
  }

  /* ── Editing ─────────────────────────────────────────────────────────── */

  return (
    <ListGroup header="用我自己的 API key">
      <div className="flex flex-col gap-3 p-4">
        <div className="rounded-[10px] bg-[color:var(--fill)] p-3">
          <p className="t-footnote font-semibold">这个 key 会怎么被使用</p>
          <ul className="t-footnote mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[color:var(--label-secondary)]">
            <li>
              只存在<strong className="text-[color:var(--label)]">这台设备的浏览器里</strong>，
              不上传、不同步、不进对局导出的 JSON
            </li>
            <li>
              分析时由<strong className="text-[color:var(--label)]">你的浏览器直接请求模型服务商</strong>，
              我们的服务器完全不参与 —— 你可以在浏览器的网络面板里自己核实
            </li>
            <li>费用记在你自己的账上，也不再受我们的次数限制</li>
          </ul>
          <p className="t-caption mt-2 text-[color:var(--orange)]">
            代价：浏览器里存着的东西，这台设备上的其他脚本理论上读得到。公用电脑上别存，用完记得删。
          </p>
        </div>

        <div>
          <label htmlFor="byok-key" className="t-footnote mb-1 block px-1 font-medium">
            API Key
          </label>
          <input
            id="byok-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setStatus("idle");
              setError("");
            }}
            placeholder="sk-..."
            className="t-footnote w-full rounded-[10px] bg-[color:var(--bg)] px-3.5 py-3 font-mono outline-none placeholder:text-[color:var(--label-tertiary)]"
          />
        </div>

        <div>
          <label htmlFor="byok-model" className="t-footnote mb-1 block px-1 font-medium">
            模型
          </label>
          <input
            id="byok-model"
            autoComplete="off"
            spellCheck={false}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setStatus("idle");
            }}
            placeholder={DEFAULT_MODEL}
            className="t-footnote w-full rounded-[10px] bg-[color:var(--bg)] px-3.5 py-3 font-mono outline-none placeholder:text-[color:var(--label-tertiary)]"
          />
        </div>

        <details className="t-footnote">
          <summary className="min-h-[32px] cursor-pointer text-[color:var(--label-secondary)]">
            用别家的服务？（DeepSeek、Qwen、自建…）
          </summary>
          <input
            aria-label="接口地址"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setStatus("idle");
            }}
            placeholder="https://api.openai.com/v1"
            className="t-footnote mt-2 w-full rounded-[10px] bg-[color:var(--bg)] px-3.5 py-3 font-mono outline-none placeholder:text-[color:var(--label-tertiary)]"
          />
          <p className="t-caption mt-1.5 px-1 text-[color:var(--label-tertiary)]">
            填到 /v1 为止。要求对方支持浏览器跨域调用，否则会连不上。
          </p>
        </details>

        {error && <InlineWarning>{error}</InlineWarning>}
        {status === "ok" && (
          <p className="t-footnote rounded-[10px] bg-[color:var(--fill)] px-3 py-2 text-[color:var(--green)]">
            通了 —— 这个 key 可以调用「{model.trim() || DEFAULT_MODEL}」。
          </p>
        )}

        <div className="flex gap-2">
          <Button
            variant="gray"
            className="flex-1"
            disabled={status === "testing"}
            onClick={() => void test()}
          >
            {status === "testing" ? "测试中…" : "测一下"}
          </Button>
          <Button className="flex-1" onClick={save}>
            存下来
          </Button>
        </div>
        <Button
          variant="plain"
          onClick={() => {
            setEditing(false);
            setKey("");
          }}
        >
          取消
        </Button>
      </div>
    </ListGroup>
  );
}
