"use client";

import { useState } from "react";
import Link from "next/link";
import { GameHeader } from "@/components/game/game-header";
import { OpinionSheet } from "@/components/game/opinion-sheet";
import { ProposalBuilder } from "@/components/game/proposal-builder";
import { VoteRecorder } from "@/components/game/vote-recorder";
import { MissionRecorder } from "@/components/game/mission-recorder";
import { TextNoteComposer } from "@/components/game/text-note-composer";
import { PlayerGrid } from "@/components/ui/player-grid";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle, WarningBanner } from "@/components/ui/feedback";
import { RatingBadge } from "@/components/ui/rating-chips";
import {
  useEvents,
  useGame,
  useOpinions,
  usePlayers,
  useTimeline,
} from "@/lib/store/hooks";
import { describeEvent, seatLabel, seatList } from "@/lib/format/labels";

type Sheet = "opinion" | "proposal" | "vote" | "mission" | "note" | null;

export default function GamePage() {
  const game = useGame();
  const timeline = useTimeline();
  const events = useEvents();
  const players = usePlayers();
  const opinions = useOpinions();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [speakerId, setSpeakerId] = useState<string | null>(null);

  if (!game || !timeline) return null;

  const proposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  const recent = events.slice(-6).reverse();

  /*
   * GamePhase controls exactly one thing: which primary action is offered.
   * Opinion and note input stay available in every phase — players keep talking
   * while a vote is being counted.
   */
  const cta = timeline.isComplete
    ? null
    : timeline.phase === "discussion"
      ? { label: "点车", sheet: "proposal" as const }
      : timeline.phase === "voting"
        ? { label: "记投票", sheet: "vote" as const }
        : { label: "记任务结果", sheet: "mission" as const };

  return (
    <>
      <GameHeader game={game} timeline={timeline} />

      <main className="mx-auto max-w-md px-4 pb-28 pt-4">
        {timeline.isComplete && (
          <Card className="mb-4 border-accent">
            <p className="text-[15px] font-medium">这局已经打完了</p>
            <p className="mt-1 text-[13px] text-fg-muted">
              {timeline.completionReason === "missions_good" && "好人拿下 3 轮任务。"}
              {timeline.completionReason === "missions_evil" && "坏人拿下 3 轮任务。"}
              {timeline.completionReason === "rejection_limit" && "连挂 5 次，坏人获胜。"}
              {timeline.completionReason === "manual" && "已手动结束。"}
            </p>
            <Link href={`/game/${game.id}/settings`} className="mt-3 block">
              <Button variant="secondary" fullWidth>
                结束对局 / 导出记录
              </Button>
            </Link>
          </Card>
        )}

        {proposal && (
          <section className="mb-5">
            <SectionTitle>
              {proposal.status === "voting" ? "这辆车等投票" : "这辆车过了，等任务结果"}
            </SectionTitle>
            <Card>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[15px]">
                  <span className="font-medium">
                    {seatLabel(game, proposal.event.leaderId)}
                  </span>{" "}
                  点车
                </span>
                <span className="text-[12px] text-fg-subtle">
                  {proposal.event.teamPlayerIds.length} / {proposal.expectedTeamSize} 人
                </span>
              </div>
              <p className="mt-1.5 text-lg font-semibold tabular-nums">
                {seatList(game, proposal.event.teamPlayerIds)}
              </p>
              {proposal.teamSizeMismatch && (
                <WarningBanner className="mt-2">
                  这轮通常是 {proposal.expectedTeamSize} 个人上车。
                </WarningBanner>
              )}
            </Card>
          </section>
        )}

        <section className="mb-5">
          <SectionTitle>点一个人，记他怎么看别人</SectionTitle>
          <PlayerGrid
            players={players}
            leaderId={timeline.currentLeaderId}
            onSelect={(id) => {
              setSpeakerId(id);
              setSheet("opinion");
            }}
            renderSubtitle={(player) => {
              const said = opinions?.current.get(player.id)?.size ?? 0;
              return said > 0 ? `表态 ${said}` : undefined;
            }}
          />
          <p className="mt-2 text-[12px] text-fg-subtle">
            蓝色的是当前队长。空白格表示还没表过态。
          </p>
        </section>

        <section>
          <SectionTitle
            action={
              <Link
                href={`/game/${game.id}/timeline`}
                className="text-[13px] font-medium text-accent"
              >
                全部
              </Link>
            }
          >
            刚刚记的
          </SectionTitle>
          {recent.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-[13px] text-fg-subtle">
              还没记东西。听到谁保谁踩，点上面的座位号。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {recent.map((event) => (
                <li
                  key={event.id}
                  className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-[13px]"
                >
                  {event.type === "opinion" ? (
                    <>
                      <RatingBadge rating={event.rating} />
                      <span className="min-w-0 flex-1 truncate">
                        {seatLabel(game, event.speakerId)} →{" "}
                        {seatLabel(game, event.targetId)}
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">
                      {describeEvent(event, game)}
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-fg-subtle">
                    第{event.missionNumber}轮
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {/* Primary actions sit in the lower half of the screen: this app is used
          one-handed, mid-conversation. */}
      <div className="pb-safe fixed inset-x-0 bottom-[4.5rem] z-30 px-4">
        <div className="mx-auto flex max-w-md gap-2">
          {cta && (
            <Button
              size="lg"
              className="flex-1 shadow-lg"
              onClick={() => setSheet(cta.sheet)}
            >
              {cta.label}
            </Button>
          )}
          <Button
            size="lg"
            variant="secondary"
            className={cta ? "shadow-lg" : "flex-1 shadow-lg"}
            onClick={() => setSheet("note")}
          >
            记一条
          </Button>
        </div>
      </div>

      <OpinionSheet
        speakerId={sheet === "opinion" ? speakerId : null}
        onClose={() => setSheet(null)}
      />
      <ProposalBuilder
        open={sheet === "proposal"}
        onClose={() => setSheet(null)}
      />
      <VoteRecorder open={sheet === "vote"} onClose={() => setSheet(null)} />
      <MissionRecorder
        open={sheet === "mission"}
        onClose={() => setSheet(null)}
      />
      <TextNoteComposer open={sheet === "note"} onClose={() => setSheet(null)} />
    </>
  );
}
