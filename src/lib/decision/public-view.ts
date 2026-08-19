/**
 * The game as everyone at the table can see it.
 *
 * The frozen belief engine is USER-CONDITIONED: it reads role_mark events and
 * the viewer's own role, so its posterior encodes private sight. That is
 * correct for the user's own decision, and wrong for anything a simulated
 * player is supposed to reason from.
 *
 * A rollout that fed the user-conditioned posterior to the simulated table
 * would have five strangers voting as if they could see Merlin's vision. The
 * value it estimated would be the value of a game nobody is playing.
 *
 * So the policy's public read comes from here: the same log with the private
 * layer removed and the viewer's role forgotten. Each simulated actor then has
 * its OWN private information layered on top by the policy, and only its own.
 */

import { isPrivateEvent, type GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";

export interface PublicView {
  events: GameEvent[];
  game: GameRecord;
}

export function publicView(
  events: readonly GameEvent[],
  game: GameRecord,
): PublicView {
  return {
    events: (events as GameEvent[]).filter((e) => !isPrivateEvent(e)),
    // viewerPlayerId stays: which seat the user occupies is public. What they
    // ARE is not, and the belief layer branches on exactly that.
    game: { ...game, viewerRole: undefined, scratchpad: undefined },
  };
}
