/**
 * Pull every game out of the AvalonLogs git objects.
 *
 * The repo cannot be checked out on Windows — filenames contain ':' — so the
 * blobs are read straight from the object database via `git cat-file --batch`,
 * which is also far faster than 12,884 separate process launches.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const REPO = __dirname + "/avalonlogs";

function listBlobs() {
  const out = require("node:child_process")
    .execSync("git ls-tree -r HEAD", { cwd: REPO, maxBuffer: 64 << 20 })
    .toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[2])
    .filter(Boolean);
}

async function readAll(shas) {
  return new Promise((resolve, reject) => {
    const git = spawn("git", ["cat-file", "--batch"], { cwd: REPO });
    const chunks = [];
    git.stdout.on("data", (c) => chunks.push(c));
    git.on("error", reject);
    git.on("close", () => {
      const buf = Buffer.concat(chunks);
      const games = [];
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl === -1) break;
        const header = buf.slice(pos, nl).toString();
        const parts = header.split(" ");
        if (parts[1] !== "blob") break;
        const size = Number(parts[2]);
        const body = buf.slice(nl + 1, nl + 1 + size).toString("utf8");
        pos = nl + 1 + size + 1;
        try {
          games.push(JSON.parse(body));
        } catch {
          /* a few logs are not JSON; skip */
        }
      }
      resolve(games);
    });
    git.stdin.write(shas.join("\n") + "\n");
    git.stdin.end();
  });
}

(async () => {
  const shas = listBlobs();
  console.log("blobs:", shas.length);
  const games = await readAll(shas);
  console.log("parsed:", games.length);

  // Keep only complete Avalon games: real roles revealed, players present.
  const usable = games.filter(
    (g) =>
      g?.outcome?.roles?.length &&
      g?.players?.length &&
      Array.isArray(g.missions),
  );
  console.log("usable:", usable.length);

  const bySize = {};
  const byState = {};
  for (const g of usable) {
    bySize[g.players.length] = (bySize[g.players.length] ?? 0) + 1;
    byState[g.outcome.state] = (byState[g.outcome.state] ?? 0) + 1;
  }
  console.log("按人数:", bySize);
  console.log("结局:", byState);

  const roleCounts = {};
  for (const g of usable)
    for (const r of g.outcome.roles)
      roleCounts[r.role] = (roleCounts[r.role] ?? 0) + 1;
  console.log("出现过的角色:", roleCounts);

  fs.writeFileSync(__dirname + "/games.json", JSON.stringify(usable));
  console.log("written games.json");
})();
