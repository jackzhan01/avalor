import { GameProvider } from "@/components/game/game-provider";
import { BottomNav } from "@/components/ui/bottom-nav";
import { SnackbarHost } from "@/components/ui/snackbar";

/**
 * The three tabs live under this layout as siblings, which is the single most
 * important routing decision in the app: switching tabs keeps this layout
 * mounted, so the event log is read from IndexedDB once per game, not once per
 * navigation.
 */
export default async function GameLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  return (
    <GameProvider gameId={gameId}>
      <div className="pb-[4.5rem]">{children}</div>
      <BottomNav gameId={gameId} />
      <SnackbarHost />
    </GameProvider>
  );
}
