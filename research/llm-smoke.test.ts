import { it } from "vitest";
import { askJson, llmAvailable, modelName, reportUsage } from "./llm-client";

/** One live call, to confirm the key, the model name and the JSON mode all work. */
it("reaches the model", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  console.log("");
  console.log(`模型：${modelName()}`);
  const out = await askJson(
    "You answer only with JSON.",
    'Reply with exactly {"ok": true, "seats": [1,2,3]}.',
  );
  console.log("回答：", JSON.stringify(out));
  reportUsage();
}, 300_000);
