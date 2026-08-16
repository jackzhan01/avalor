"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useGameStore } from "@/lib/store/game-store";
import { useHydrated, useLoadError, useLoadStatus } from "@/lib/store/hooks";
import { Skeleton } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";

/**
 * The client boundary for a game. Loads the log from IndexedDB exactly once and
 * holds it for as long as any of the three tabs is mounted.
 *
 * The hydration gate matters: "use client" does not mean "not server-rendered".
 * This component IS prerendered into the initial HTML, so the first render must
 * produce the skeleton and must not touch Dexie. Server and first client render
 * then agree, and there is no hydration mismatch.
 */
export function GameProvider({
  gameId,
  children,
}: {
  gameId: string;
  children: React.ReactNode;
}) {
  const hydrated = useHydrated();
  const status = useLoadStatus();
  const error = useLoadError();
  const loadGame = useGameStore((s) => s.loadGame);
  const unload = useGameStore((s) => s.unload);

  useEffect(() => {
    if (!hydrated) return;
    void loadGame(gameId);
    return () => unload();
  }, [hydrated, gameId, loadGame, unload]);

  if (!hydrated || status === "idle" || status === "loading") {
    return <GameSkeleton />;
  }

  if (status === "error") {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-base font-medium">{error ?? "打不开这局游戏。"}</p>
        <p className="text-sm text-fg-muted">
          可能是链接不对，或者这局记录已经被删掉了。
        </p>
        <Link href="/">
          <Button variant="secondary">回到首页</Button>
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}

function GameSkeleton() {
  return (
    <div className="mx-auto max-w-md space-y-3 px-4 py-4">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
