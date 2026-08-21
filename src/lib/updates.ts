/**
 * 更新日志 —— 给用的人看的那一份。
 *
 * 和仓库根目录的 CHANGELOG.md 是两回事，别把两边写成一样。那边记的是代码
 * 里发生了什么（改了哪个函数、修了哪个 bug），这边记的是**你能感觉到的
 * 变化**：多了什么按钮、少等了几秒、哪里以前会骗你现在不会了。
 *
 * 三条约定，破了就会慢慢烂掉：
 *
 *   1. 用第二人称写。是「你现在可以…」，不是「新增了…功能」。
 *   2. 只写用户能验证的事。「重构了推演层」不属于这里。
 *   3. 已知的坏消息也写。上线时就知道有毛病却不说，用户会自己发现，
 *      然后连带不再信任这里写的好消息。
 *
 * 最新的排最前面。加新条目就往数组头上加。
 */

export interface UpdateEntry {
  /** 展示用的版本号，也是「看过没」的标记，必须唯一且单调。 */
  version: string;
  /** ISO 日期，只用于展示。 */
  date: string;
  /** 一句话说清这次的重点。 */
  title: string;
  /** 你能直接看到或用到的变化。 */
  highlights: string[];
  /** 上线时就已知的毛病。写出来，别等用户自己撞上。 */
  caveats?: string[];
}

export const UPDATES: UpdateEntry[] = [
  {
    version: "1.0",
    date: "2026-08-20",
    title: "会帮你算该怎么走了",
    highlights: [
      "牌桌页多了「该怎么走」：上票还是下票、轮到你点车该点谁，全在你手机上算，不联网、不花钱、关掉 Wi-Fi 照样能用。",
      "会告诉你桌上这辆车崩掉的概率，以及它在所有可能的车里算干净还是脏。",
      "轮到你点车时，会把全部合法组合都过一遍，给你一个推荐和几个备选。",
      "算不准的时候它会直说「太接近，两边都行」，不会硬凑一个建议给你。",
      "支持 7 到 10 人局。",
    ],
    caveats: [
      "投票这件事，你一票在 9 人局里只有其余 8 人 4-4 时才真的改变结果。所以大多数时候上票和下票的胜率差都很小，会被判成「太接近」—— 这时候真正有用的是那个崩车概率，不是胜率差。",
      "8 人局的模拟胜率偏低（好人 .30，真实牌局约 .41）。偏差方向是一致的，所以「哪个选择更好」不受影响，但绝对胜率数字在 8 人局要打个折扣看。",
      "10 人局分析一次要 3 到 4 秒。",
    ],
  },
  {
    version: "0.9",
    date: "2026-08-17",
    title: "登录、云备份、AI 分析",
    highlights: [
      "可以用邮箱登录了，登录之后能把对局备份到云端，换手机也在。",
      "「分析局势」和「帮我发言」：把这局的记录交给模型，让它帮你捋一遍或者写个发言大纲。",
      "分析结果会留着，关掉再打开不用重新花一次钱。",
      "排除法推演：哪些人已经**不可能**是坏人，是规则推出来的，不是猜的。",
    ],
    caveats: [
      "AI 功能要登录并且在白名单里 —— 那两个按钮花的是我们自己的钱。",
    ],
  },
  {
    version: "0.5",
    date: "2026-08-10",
    title: "记录本本体",
    highlights: [
      "记保踩、记点车、记票型、记任务结果，整局按时间线回看。",
      "票型存的是每个座位投了什么，不是「6-4 通过」—— 不同的 6 个人意思完全不一样。",
      "改口不会覆盖历史：3 号对 6 号从「保」改成「踩」，两条都留着。",
      "任何一条都能改能删，删错了有撤销。",
      "数据只存在你这台设备上。",
    ],
  },
];

/** 最新版本号，也是「看过没」比较的基准。 */
export const LATEST_VERSION = UPDATES[0]?.version ?? "0";

const SEEN_KEY = "avalor.updates.seen.v1";

/**
 * 用户看过的最新版本号。
 *
 * 放 localStorage 而不是 Dexie：它不是牌局数据，不该进导出，也不该跟着对局
 * 备份到云端。读不到就当没看过 —— 隐私模式下多显示一次红点，比崩掉好。
 */
export function lastSeenVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markUpdatesSeen(version: string = LATEST_VERSION): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_KEY, version);
  } catch {
    // 存不下就算了，代价只是下次再看到一个红点。
  }
}

/**
 * 有没有没看过的新东西。
 *
 * 从没看过的老用户会看到红点，这是故意的 —— 他们确实没看过。但全新用户第一
 * 次打开时不该被当成「有更新」，所以判断交给调用方：只有已经有对局记录的人
 * 才值得提醒。
 */
export function hasUnseenUpdates(): boolean {
  return lastSeenVersion() !== LATEST_VERSION;
}
