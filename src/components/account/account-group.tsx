"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { backupAll, listBackups, restoreMissing } from "@/lib/cloud/backup";
import { ListGroup, ListRow } from "@/components/ui/list";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { browserClient, isConfigured } from "@/lib/auth/supabase-browser";
import * as repo from "@/lib/db/repository";
import { useHydrated } from "@/lib/store/hooks";

/**
 * The two rows on the menu that are about you rather than about a game.
 *
 * Login is offered here, never enforced anywhere. A notebook for a live table
 * has to open and record in one tap — a signup wall would land at the exact
 * moment a game is starting, and would make email delivery a single point of
 * failure for a product that otherwise needs no network at all.
 *
 * So the row states what signing in *unlocks*. Someone who wants an account
 * can find one; someone who wants to record a game never meets one.
 *
 * The name is deliberately NOT part of that: it is a device preference, stored
 * locally like everything else here. Wanting the app to know what to call you
 * is not a reason to need a server.
 */
export function AccountGroup() {
  const hydrated = useHydrated();
  const router = useRouter();

  const [name, setName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const [email, setEmail] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  const [backupOpen, setBackupOpen] = useState(false);
  const [cloudCount, setCloudCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "up" | "down">(null);
  const [result, setResult] = useState<string | null>(null);

  const backupDetail =
    cloudCount === null ? "查看备份状态" : `云端有 ${cloudCount} 局`;

  const refreshCloud = useCallback(() => {
    listBackups()
      .then((rows) => setCloudCount(rows.length))
      .catch(() => setCloudCount(null));
  }, []);

  useEffect(() => {
    if (email) refreshCloud();
  }, [email, refreshCloud]);

  useEffect(() => {
    if (!hydrated) return;
    void repo
      .readSetting<string>(repo.SETTING_DISPLAY_NAME)
      .then((value) => setName(value ?? null));
  }, [hydrated]);

  /*
   * Read at build time from an inlined NEXT_PUBLIC_ value, so it is identical
   * on the server and the first client render — safe to branch on directly.
   */
  const backend = isConfigured();

  useEffect(() => {
    if (!hydrated || !backend) {
      setChecked(true);
      return;
    }
    void browserClient()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null))
      .catch(() => setEmail(null))
      .finally(() => setChecked(true));
  }, [hydrated, backend]);

  async function saveName() {
    const value = draft.trim().slice(0, 12);
    await repo.writeSetting(repo.SETTING_DISPLAY_NAME, value);
    setName(value || null);
    setEditing(false);
  }

  async function run(direction: "up" | "down") {
    setBusy(direction);
    setResult(null);
    try {
      if (direction === "up") {
        const { uploaded } = await backupAll();
        setResult(
          uploaded === 0 ? "这台设备上还没有对局。" : `已备份 ${uploaded} 局。`,
        );
      } else {
        const { restored, skipped } = await restoreMissing();
        setResult(
          restored === 0
            ? "本机已经有云端的全部对局了。"
            : `恢复了 ${restored} 局${skipped > 0 ? `，跳过本机已有的 ${skipped} 局` : ""}。`,
        );
      }
      refreshCloud();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "操作失败，稍后再试。");
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    await browserClient().auth.signOut();
    setEmail(null);
    router.refresh();
  }

  return (
    <>
      <ListGroup
        footer={
          !backend
            ? "这个版本没有账号功能，所有记录都存在本机。"
            : email
              ? "已登录。牌局记录依然只存在这台设备上，登录不会上传任何一局。"
              : "登录是可选的 —— 不登录，记录功能一样完整可用。"
        }
      >
        <ListRow
          label="我的名字"
          detail="只存在这台设备上"
          value={name ?? "未设置"}
          accessory="chevron"
          onClick={() => {
            setDraft(name ?? "");
            setEditing(true);
          }}
        />

        {/*
         * Skipped entirely with no backend configured: offering a login that
         * lands on a page saying there is nothing to log into is worse than
         * not offering one. Rendered only once the session check has settled,
         * because flashing 「登录」 at someone already signed in reads as
         * having been logged out.
         */}
        {backend &&
          checked &&
          (email ? (
            <>
              <ListRow
                label="云端备份"
                detail={backupDetail}
                accessory="chevron"
                onClick={() => setBackupOpen(true)}
              />
              <ListRow
                label="账号"
                detail={email}
                value="退出"
                onClick={() => void signOut()}
              />
            </>
          ) : (
            <ListRow
              label="登录"
              detail="解锁云端备份和 AI 内测"
              accessory="chevron"
              href="/login?next=/menu"
            />
          ))}
      </ListGroup>

      <Sheet
        open={backupOpen}
        onClose={() => {
          setBackupOpen(false);
          setResult(null);
        }}
        title="云端备份"
        subtitle={backupDetail}
      >
        <div className="flex flex-col gap-3">
          <Button
            fullWidth
            size="lg"
            disabled={busy !== null}
            onClick={() => void run("up")}
          >
            {busy === "up" ? "上传中…" : "备份这台设备的全部对局"}
          </Button>
          <Button
            fullWidth
            size="lg"
            variant="gray"
            disabled={busy !== null}
            onClick={() => void run("down")}
          >
            {busy === "down" ? "下载中…" : "把云端缺失的对局恢复到本机"}
          </Button>

          {result && (
            <p className="t-footnote px-1 text-[color:var(--label-secondary)]">
              {result}
            </p>
          )}

          {/*
           * Said before the tap, not after. This is the only feature in the app
           * that sends a game off the device, and it sends the private layer
           * too — a backup without your own role and your reads would restore
           * a game you no longer recognise.
           */}
          <p className="t-footnote mt-3 px-1 leading-relaxed text-[color:var(--label-tertiary)]">
            备份会上传完整记录，
            <strong className="text-[color:var(--label-secondary)]">
              包括你自己的身份和你对每个人的推测
            </strong>
            。只有你自己的账号读得到。不备份的话，记录只在这台设备上 ——
            换手机或者浏览器清数据就没了。
          </p>
          <p className="t-footnote px-1 leading-relaxed text-[color:var(--label-tertiary)]">
            恢复只会补上本机没有的对局，不会覆盖你正在记的那些。
          </p>
        </div>
      </Sheet>

      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="我的名字"
        trailing={null}
        footer={
          <Button fullWidth size="lg" onClick={() => void saveName()}>
            保存
          </Button>
        }
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={12}
          autoFocus
          placeholder="怎么称呼你"
          aria-label="名字"
          className="t-body min-h-[48px] w-full rounded-[12px] bg-[color:var(--fill)] px-3.5 outline-none"
        />
        <p className="t-footnote mt-2 px-1 text-[color:var(--label-secondary)]">
          留空就是不设置。这个名字不会离开这台设备。
        </p>
      </Sheet>
    </>
  );
}
