/**
 * The deterministic disclosure firewall.
 *
 * Sits between the private strategist and the public spokesperson, and between
 * the spokesperson and the public log. Two jobs, and they fail differently on
 * purpose:
 *
 *   SANITISE THE ENVELOPE (before stage 2). Ids that are not `table-public`
 *   are stripped. Text fields carrying a protected secret are REDACTED
 *   WHOLESALE — not excised, not rewritten. Excising a substring from a
 *   sentence leaves a sentence that still means what it meant; replacing the
 *   whole field leaves the spokesperson with nothing to leak. Every removal is
 *   recorded, so a planner that keeps trying is visible in the trace rather
 *   than quietly handled.
 *
 *   VALIDATE THE MESSAGE (after stage 2). If the finished sentence discloses
 *   anything, it does NOT enter the public log, is never shown to another
 *   agent, and is never shown back to the spokesperson as repair context. The
 *   retry is the identical sanitised prompt, for the same reason the capacity
 *   retry is byte-identical: nothing about the request was wrong, and handing
 *   the model its own leaking sentence to "fix" is handing it the secret.
 *
 * NO MODEL INPUT ANYWHERE IN THIS FILE. Every decision comes from the fact-id
 * registry, the observation-derived secrets, and the task. `informationToConceal`
 * — the field the M5.2 pilot had the model fill in — is not read here and must
 * never be: that game recorded it correctly on every turn and leaked anyway.
 *
 * WHAT THIS FILE IS NOT. It is not the reason the pair stays private. The
 * reason is that `buildSpokespersonPrompt` cannot see the pair; see the header
 * of `spokesperson.ts` and the non-interference tests. This is defence in
 * depth, and `secrets.ts` is explicit about the limits of a text detector.
 */

import type { Phase } from "../core/state";
import type { PublicEvent } from "../core/events";
import type { Observation } from "../core/observation";
import type { Seat } from "../core/types";
import type { PersonaDefinition } from "../prompts/personas";
import {
  ALL_SECRET_CLASSES,
  CHANNEL_LABELS,
  SECRET_LABELS,
  classifyFactId,
  type SecretClass,
  type VisibilityChannel,
} from "./classification";
import type { VisibleFactRegistry } from "./fact-ids";
import type { CommunicationIntent, IntentChannel, SanitisedIntent } from "./intent";
import { findMachineIds, type MachineIdHit } from "./machine-ids";
import { pairRisk } from "./pair-disclosure";
import {
  findDisclosures,
  protectedSecretsFor,
  type Disclosure,
  type DisclosureContext,
  type ProtectedSecrets,
} from "./secrets";

/* ── The public-only registry ───────────────────────────────────────────── */

/**
 * A registry with the private half removed.
 *
 * A SEPARATE OBJECT rather than a filter applied at lookup time, because the
 * spokesperson side should not be holding a structure that contains private
 * entries at all. A filter is a rule somebody can forget to apply; an object
 * that never held the entries cannot leak them however it is used.
 */
export interface PublicBasisRegistry {
  readonly entries: readonly { readonly id: string; readonly label: string }[];
  readonly byId: ReadonlyMap<string, string>;
}

export function publicOnly(registry: VisibleFactRegistry): PublicBasisRegistry {
  const entries: { id: string; label: string }[] = [];
  for (const entry of registry.entries) {
    if (classifyFactId(registry, entry.id).channel !== "table-public") continue;
    entries.push({ id: entry.id, label: entry.label });
  }
  const byId = new Map<string, string>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e.label);
  return { entries, byId };
}

/* ── The audit record ───────────────────────────────────────────────────── */

/** Why one id or field did not make it across. */
export interface FirewallRemoval {
  readonly what: string;
  readonly reason: string;
  readonly channel: VisibilityChannel | null;
  readonly secretClass: SecretClass | null;
}

/**
 * What crossed and what did not. PRIVATE — it names rejected content.
 *
 * Kept as data rather than as a log line because the research questions are
 * counting questions: how often did a planner try, which class, which field.
 * A string nobody can group by answers none of them.
 */
export interface DisclosureAudit {
  readonly seat: Seat;
  readonly taskId: string;
  readonly channel: IntentChannel;
  readonly phase: Phase;
  /** Ids that resolved to `table-public` and were handed to stage 2. */
  readonly allowedBasisIds: readonly string[];
  /** Ids that did not, with the classification that stopped them. */
  readonly rejectedBasisIds: readonly FirewallRemoval[];
  /** Envelope text fields replaced wholesale because they carried a secret. */
  readonly redactedFields: readonly FirewallRemoval[];
  /** The secret classes this seat held at this moment. Classes, never values. */
  readonly secretClassesHeld: readonly SecretClass[];
  /** Set when the planner's declared channel disagreed with the task's. */
  readonly channelCorrected: boolean;
}

/**
 * Which evidence authorised one public sentence.
 *
 * PRIVATE, and the reason `naturalPublicSpeech` does not cost auditability.
 * The table hears 「第二轮 7 号发的 1、2、3、4 出了三张失败票」 and the trace
 * records that the sentence was authorised by `f30` and `f32` — so a reviewer
 * can still resolve every public claim back to a referee record, mechanically,
 * without the ids ever having been spoken.
 *
 * The sentence itself is safe to store: it is public by the time this is
 * written. Only ACCEPTED sentences are recorded; a refused one is described by
 * its rules and never by its text.
 */
export interface SentenceProvenance {
  readonly taskId: string;
  readonly sentence: string;
  readonly authorisedBy: readonly string[];
}

/** A field that a firewall replaced. Stable text, so a test can pin it. */
export const REDACTED = "（这一段含私有信息，已被系统整段移除）";

/* ── Sanitising the envelope ────────────────────────────────────────────── */

export interface SanitiseInput {
  readonly intent: CommunicationIntent;
  readonly observation: Observation;
  readonly registry: VisibleFactRegistry;
  readonly persona: PersonaDefinition;
  readonly taskId: string;
  /** The channel the TASK permits. The planner's declaration never overrides it. */
  readonly taskChannel: IntentChannel;
}

export interface SanitiseResult {
  readonly intent: SanitisedIntent;
  readonly audit: DisclosureAudit;
  readonly publicRegistry: PublicBasisRegistry;
}

/**
 * Turn what the planner asked for into what the spokesperson may see.
 *
 * Total: it always returns an envelope. There is no "reject the turn" path
 * here, and that is deliberate — stage 1 already chose a legal action, and
 * throwing the action away because its cover note leaked would punish the
 * wrong half of the answer. What leaks is removed and counted.
 */
export function sanitiseIntent(input: SanitiseInput): SanitiseResult {
  const { intent, observation, registry, persona } = input;
  const secrets = protectedSecretsFor(observation);
  const publicRegistry = publicOnly(registry);
  const context = disclosureContextFor(observation, input.taskId);

  const allowedBasisIds: string[] = [];
  const rejectedBasisIds: FirewallRemoval[] = [];
  for (const id of intent.publicBasisIds) {
    const label = publicRegistry.byId.get(id);
    if (label !== undefined) {
      if (!allowedBasisIds.includes(id)) allowedBasisIds.push(id);
      continue;
    }
    const classification = classifyFactId(registry, id);
    rejectedBasisIds.push({
      what: id,
      reason:
        registry.byId.has(id)
          ? `这个 id 是 ${CHANNEL_LABELS[classification.channel]}，不能作为公开依据`
          : "这个 id 在这个座位的注册表里查不到（造的、写错的、或者已经过时的）",
      channel: classification.channel,
      secretClass: classification.secretClass,
    });
  }

  const redactedFields: FirewallRemoval[] = [];
  const scrub = (name: string, text: string): string => {
    const found = findDisclosures(text, secrets, context);
    if (found.length === 0) return text;
    redactedFields.push({
      what: name,
      reason: found.map((f) => `${f.rule}：${f.detail}`).join("；"),
      channel: null,
      secretClass: found[0].secretClass,
    });
    return REDACTED;
  };

  // The task decides the channel. A planner that writes `evil-council` on an
  // ordinary speech does not get an evil-council spokesperson; it gets the
  // table-public one and a note in the audit.
  const channelCorrected = intent.channel !== input.taskChannel;

  const sanitised: SanitisedIntent = {
    channel: input.taskChannel,
    publicGoal: scrub("publicGoal", intent.publicGoal),
    targetSeats: intent.targetSeats,
    selectedClaimAction: intent.selectedClaimAction,
    requestedTeam: intent.requestedTeam,
    requestedVote: intent.requestedVote,
    publicBasisIds: allowedBasisIds,
    publicBasis: allowedBasisIds.map((id) => ({
      id,
      label: publicRegistry.byId.get(id) ?? "",
    })),
    publicProposition: scrub("publicProposition", intent.publicProposition),
    desiredTableEffect: scrub("desiredTableEffect", intent.desiredTableEffect),
    styleId: persona.id,
    // THE CONSTANT LIST, not this seat's holdings. See `ALL_SECRET_CLASSES`:
    // "you hold a Merlin vision" identifies the seat, and the role-substitution
    // test refuses a stage-2 prompt that varies with the deal. What the seat
    // actually holds goes into the audit below, which is private.
    factsThatMustRemainPrivate: ALL_SECRET_CLASSES,
  };

  return {
    intent: sanitised,
    publicRegistry,
    audit: {
      seat: observation.seat,
      taskId: input.taskId,
      channel: input.taskChannel,
      phase: observation.position.phase,
      allowedBasisIds,
      rejectedBasisIds,
      redactedFields,
      secretClassesHeld: secretClassesHeld(secrets),
      channelCorrected,
    },
  };
}

/**
 * Which secret classes this seat actually holds. PRIVATE — audit only.
 *
 * An earlier draft handed this to the spokesperson, on the reasoning that
 * naming a class is safer than naming a value. It is not safe enough: a
 * spokesperson told "this seat holds a Merlin vision" has been told the role.
 * The role-substitution test failed on exactly that line, which is what these
 * tests are for. Stage 2 now gets `ALL_SECRET_CLASSES` and this stays here.
 */
function secretClassesHeld(secrets: ProtectedSecrets): readonly SecretClass[] {
  const held: SecretClass[] = ["private-cognition"];
  if (secrets.percivalPair.length > 0) held.push("private-percival-pair");
  if (secrets.merlinVision.length > 0) held.push("private-merlin-vision");
  if (secrets.knownTeammates.length > 0 || secrets.evilRoster.length > 0) {
    held.push("private-evil-roster");
  }
  if (secrets.ladyTruths.length > 0) held.push("private-lady-result");
  held.push("private-role");
  return held;
}

/* ── Validating the finished message ────────────────────────────────────── */

export type MessageVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly disclosures: readonly Disclosure[];
      /** Machine ids found in a sentence meant for people. `0.6.0` only. */
      readonly machineIds: readonly MachineIdHit[];
    };

export interface ValidateInput {
  readonly message: string;
  readonly observation: Observation;
  readonly taskId: string;
  /**
   * `prompt-0.6.0`: also refuse machine evidence ids.
   *
   * Off by default so the two completed 0.5.0 games' messages still validate
   * as what they were — those transcripts are full of `[f30]`, and a checker
   * that retroactively called them invalid would be rewriting history rather
   * than describing it.
   */
  readonly naturalSpeech?: boolean;
  /**
   * `prompt-0.7.0`: also refuse a sentence that GROUPS both real candidates.
   *
   * Off by default for the same reason `naturalSpeech` is: the 0.5.0 and 0.6.0
   * transcripts contain 「1、3、7、9我都看不清」 and a checker that retroactively
   * called it invalid would be rewriting the record rather than describing it.
   */
  readonly pairGrouping?: boolean;
}

/**
 * The last gate before a public event exists.
 *
 * Called on the merged answer, not on the spokesperson's raw text, so a
 * message assembled by any path — including a scripted client or a future
 * single-stage regression — goes through the same check.
 */
export function validatePublicMessage(input: ValidateInput): MessageVerdict {
  const secrets = protectedSecretsFor(input.observation);
  const context = disclosureContextFor(input.observation, input.taskId);
  const disclosures = findDisclosures(input.message, secrets, context);
  const machineIds =
    input.naturalSpeech === true ? findMachineIds(input.message) : [];

  // The diluted pair channel. Reported as a DISCLOSURE rather than as its own
  // verdict kind, so it inherits the rule that matters: no repair note, and a
  // byte-identical retry. A note would have to name the seats not to group,
  // which is the secret itself.
  const pair =
    input.pairGrouping === true
      ? pairRisk({ message: input.message, observation: input.observation })
      : null;
  const all: Disclosure[] = pair
    ? [
        ...disclosures,
        {
          secretClass: "private-percival-pair",
          rule: pair.rule,
          evidence: `${pair.marker}·${pair.groupSize}`,
          detail:
            pair.kind === "grouping"
              ? `一个 ${pair.groupSize} 人的认知分组里同时装着两个真候选`
              : `和这个座位之前公开过的分组一交集，剩下 ${pair.groupSize} 个人，两个真候选都在里面`,
        },
      ]
    : [...disclosures];

  if (all.length === 0 && machineIds.length === 0) return { ok: true };
  return { ok: false, disclosures: all, machineIds };
}

/**
 * The channel and phase permissions for one task.
 *
 * `lady-announce` is the only task that declassifies anything, and it
 * declassifies exactly one value: the announced side, which may be a lie. The
 * evil council is the only non-table channel. Everything else declassifies
 * nothing, which is why the default is the strict pair of falses.
 */
export function disclosureContextFor(
  observation: Observation,
  taskId: string,
): DisclosureContext {
  return {
    isLadyAnnouncement: taskId === "lady-announce",
    isEvilCouncil: taskId === "evil-discuss" || isAssassinationPhase(observation.position.phase),
    publicLog: observation.publicLog as readonly PublicEvent[],
  };
}

function isAssassinationPhase(phase: Phase): boolean {
  return (
    phase === "assassination_reveal" ||
    phase === "assassination_discuss" ||
    phase === "assassination_strike"
  );
}

/** Which channel a task's message goes to. System-owned, from the task alone. */
export function channelForTask(taskId: string): IntentChannel {
  return taskId === "evil-discuss" ? "evil-council" : "table-public";
}

/** Does this task produce a natural-language message at all? */
export function taskHasPublicMessage(taskId: string): boolean {
  return (
    taskId === "opening-direction" ||
    taskId === "speech-opening" ||
    taskId === "speech-regular" ||
    taskId === "leader-close-and-propose" ||
    taskId === "lady-announce" ||
    taskId === "evil-discuss"
  );
}

/** Which JSON field the message lives in for this task. */
export function messageFieldFor(taskId: string): "publicMessage" | "message" {
  return taskId === "evil-discuss" ? "message" : "publicMessage";
}

/* ── Rendering, for the trace and the review package ────────────────────── */

export function renderAudit(audit: DisclosureAudit): string {
  const lines = [
    `${audit.seat}号 · ${audit.taskId} · ${CHANNEL_LABELS[channelLabelKey(audit.channel)]}`,
    `- 允许通过的公开依据：${audit.allowedBasisIds.length > 0 ? audit.allowedBasisIds.join("、") : "（无）"}`,
  ];
  if (audit.rejectedBasisIds.length > 0) {
    lines.push("- 被拦下的 id：");
    for (const r of audit.rejectedBasisIds) lines.push(`  - \`${r.what}\` —— ${r.reason}`);
  }
  if (audit.redactedFields.length > 0) {
    lines.push("- 被整段抹掉的字段：");
    for (const r of audit.redactedFields) {
      lines.push(
        `  - \`${r.what}\`（${r.secretClass ? SECRET_LABELS[r.secretClass] : "未分类"}）—— ${r.reason}`,
      );
    }
  }
  if (audit.channelCorrected) lines.push("- ⚠ 规划者声明的频道和任务不符，已按任务纠正");
  lines.push(
    `- 这一步该座位持有的秘密类别：${audit.secretClassesHeld.map((c) => SECRET_LABELS[c]).join("、")}`,
  );
  return lines.join("\n");
}

function channelLabelKey(channel: IntentChannel): VisibilityChannel {
  return channel === "evil-council" ? "evil-council" : "table-public";
}
