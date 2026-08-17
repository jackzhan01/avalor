"use client";

import { ListGroup, ListRow } from "@/components/ui/list";
import { InlineWarning } from "@/components/ui/feedback";
import { describeComposition, evilCount, goodCount } from "@/lib/rules/avalon";
import { ROLE_LABELS } from "@/lib/format/labels";
import type { PlayerCount, RoleSetConfig, RoleType } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

/**
 * Merlin and the Assassin are in every game; 忠臣 and 爪牙 are whatever seats
 * are left over. Only these four are a real decision, and only these four can
 * change what anyone sees.
 */
const OPTIONAL: { role: RoleType; side: "good" | "evil"; why: string }[] = [
  { role: "percival", side: "good", why: "能看到梅林和莫甘娜，但分不清" },
  { role: "morgana", side: "evil", why: "在派西维尔眼里冒充梅林" },
  { role: "mordred", side: "evil", why: "梅林看不到他" },
  { role: "oberon", side: "evil", why: "坏人之间互相不认识他" },
];

/** Read-only line-up, counts included. */
export function CompositionView({
  playerCount,
  roleSet,
}: {
  playerCount: PlayerCount;
  roleSet: RoleSetConfig;
}) {
  const composition = describeComposition(playerCount, roleSet);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <SideCard
          title={`好人 ${goodCount(playerCount)}`}
          lines={composition.good}
          tone="good"
        />
        <SideCard
          title={`坏人 ${evilCount(playerCount)}`}
          lines={composition.evil}
          tone="evil"
        />
      </div>
      {composition.problems.map((problem, i) => (
        <InlineWarning key={i}>{problem}</InlineWarning>
      ))}
    </div>
  );
}

function SideCard({
  title,
  lines,
  tone,
}: {
  title: string;
  lines: { role: RoleType; count: number }[];
  tone: "good" | "evil";
}) {
  return (
    <div className="flex-1 rounded-[10px] bg-[color:var(--bg-elevated)] p-3">
      <p
        className="t-caption font-semibold uppercase tracking-[0.06em]"
        style={{
          color: tone === "good" ? "var(--green)" : "var(--red)",
        }}
      >
        {title}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {lines.map((line) => (
          <li
            key={line.role}
            className="t-subhead flex items-baseline justify-between"
          >
            <span>{ROLE_LABELS[line.role]}</span>
            {line.count > 1 && (
              <span className="t-footnote tabular-nums text-[color:var(--label-secondary)]">
                ×{line.count}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The four roles worth arguing about, as toggles. */
export function CompositionEditor({
  playerCount,
  roleSet,
  onChange,
}: {
  playerCount: PlayerCount;
  roleSet: RoleSetConfig;
  onChange: (next: RoleSetConfig) => void;
}) {
  function toggle(role: RoleType) {
    const has = roleSet.rolesIncluded.includes(role);
    const next = has
      ? roleSet.rolesIncluded.filter((r) => r !== role)
      : [...roleSet.rolesIncluded, role];
    onChange({ rolesIncluded: next });
  }

  return (
    <ListGroup footer="梅林和刺客每局都有；剩下的位置自动补成忠臣和爪牙。">
      {OPTIONAL.map(({ role, side, why }) => {
        const on = roleSet.rolesIncluded.includes(role);
        return (
          <ListRow
            key={role}
            label={ROLE_LABELS[role]}
            detail={why}
            value={
              <span
                className={cn(
                  "t-footnote rounded-[6px] px-2 py-1 font-semibold",
                  on
                    ? "text-white"
                    : "bg-[color:var(--fill)] text-[color:var(--label-secondary)]",
                )}
                style={
                  on
                    ? {
                        backgroundColor:
                          side === "evil" ? "var(--red)" : "var(--green)",
                      }
                    : undefined
                }
              >
                {on ? "在场" : "不在"}
              </span>
            }
            onClick={() => toggle(role)}
          />
        );
      })}
      <ListRow
        label="人数"
        value={`${goodCount(playerCount)} 好 · ${evilCount(playerCount)} 坏`}
      />
    </ListGroup>
  );
}
