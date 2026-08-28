/**
 * A model double that answers the fused schema: legal action plus cognition.
 *
 * Test-only, and offline by construction — it reads the prompt and composes an
 * answer, so a whole ten-seat cognitive game runs through the real prompt
 * builder, the real strict schema, the real parser and the real reducer
 * without a provider.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: play well. The cognition it writes is
 * minimal and mechanical. These tests are about the PLUMBING — isolation,
 * provenance, persistence, bounds — and a double that reasoned convincingly
 * would make it harder to see when the plumbing broke.
 *
 * The malformed variants exist so the repair and terminal paths are exercised
 * by something that fails the way a real model fails: valid action, broken
 * memory.
 */

import { answeringClient } from "../model/scripted-client";
import type { ModelClient, ModelRequest, ModelResponse } from "../model/client";
import { extractJson } from "../model/structured";
import type { Confidence } from "./ledger";

export interface CognitiveClientOptions {
  /** Replaces the generated cognition block. Used to inject specific defects. */
  readonly mutate?: (
    cognition: Record<string, unknown>,
    request: ModelRequest,
  ) => Record<string, unknown> | null;
  /** Called with every request, so a test can inspect the rendered prompt. */
  readonly onRequest?: (request: ModelRequest) => void;
}

/**
 * Every id the prompt actually PRINTED, read back out of the rendered text.
 *
 * Reading the rendering rather than the ledger is the point. If the tables ever
 * stop printing ids again, this double starts citing nothing and the fact-id
 * tests fail — which is exactly the failure the completed pilot shipped with,
 * because nothing offline was reading what the model was shown.
 */
function renderedIds(request: ModelRequest): string[] {
  const ids: string[] = [];
  for (const match of request.user.matchAll(/`\[([^\]]+)\]`/g)) {
    const id = match[1];
    // The legend itself is written in this notation — `[f…]`, `[c…]`, `[p…]` —
    // and its placeholders are not ids. A real id is ASCII; the ellipsis is
    // what tells the two apart. A model reading the legend would make exactly
    // this mistake, and the first offline run did.
    if (!/^[\x21-\x7e]+$/.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Fact ids the prompt actually offered, so `factsUsed` cites real things. */
function factIdsFrom(request: ModelRequest): string[] {
  const rendered = renderedIds(request).filter((id) => id.startsWith("f"));
  if (rendered.length > 0) return rendered.slice(0, 3);
  // `prompt-0.3.0` printed no ids at all. Fall back to scraping the sequence
  // numbers, which is the best a model could do there — and, as the pilot
  // showed, not good enough.
  const ids = new Set<string>();
  for (const match of request.user.matchAll(/\bf(\d+)\b/g)) ids.add(`f${match[1]}`);
  return [...ids].slice(0, 3);
}

function claimIdsFrom(request: ModelRequest): string[] {
  const rendered = renderedIds(request).filter((id) => id.startsWith("c"));
  if (rendered.length > 0) return rendered.slice(0, 2);
  const ids = new Set<string>();
  for (const match of request.user.matchAll(/seq (\d+) 声称/g)) ids.add(`c${match[1]}:role`);
  return [...ids].slice(0, 2);
}

/** This seat's own private ids, so a premise can cite `p.self` legitimately. */
function privateIdsFrom(request: ModelRequest): string[] {
  return renderedIds(request).filter((id) => id.startsWith("p."));
}

/** Does this request want the 0.3.1 shape? Asked of the schema, not the text. */
function wantsSocial(request: ModelRequest): boolean {
  return Boolean(cognitionProperties(request)?.social);
}

/** Does this request want the 0.4.0 claim-contest block? */
function wantsContest(request: ModelRequest): boolean {
  return Boolean(cognitionProperties(request)?.contest);
}

function cognitionProperties(request: ModelRequest): Record<string, unknown> | undefined {
  const schema = request.format?.schema as
    | { properties?: { cognition?: { properties?: Record<string, unknown> } } }
    | undefined;
  return schema?.properties?.cognition?.properties;
}

/**
 * Seats the prompt says are currently standing on a claim.
 *
 * Read out of the RENDERED contest table, for the same reason `renderedIds`
 * reads ids out of the rendered fact tables: if the table ever stops printing
 * them, this double starts producing blocks the consistency checks reject, and
 * a test fails. A double that consulted the referee directly would keep working
 * while the prompt silently went blank — which is precisely how the M5 pilot's
 * fact-id defect survived every offline check.
 */
function standingClaimantsFrom(request: ModelRequest): number[] {
  const match = request.user.match(/正在争派西维尔的：\*\*([0-9、]+)号\*\*/);
  if (!match) return [];
  return match[1]
    .split("、")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
}

/** Whether this seat has a standing claim, per the rendered table. */
function iAmClaiming(request: ModelRequest, me: number): boolean {
  return standingClaimantsFrom(request).includes(me);
}

function seatOf(request: ModelRequest): number {
  const match = request.user.match(/你是 (\d+)号/);
  return match ? Number(match[1]) : 1;
}

function baseCognition(request: ModelRequest): Record<string, unknown> {
  const facts = factIdsFrom(request);
  const claims = claimIdsFrom(request);
  const privates = privateIdsFrom(request);
  const me = seatOf(request);
  const others = [1, 2, 3].filter((s) => s !== me);
  const standing: Confidence = "unresolved";
  // `p.self` is always in the registry, so a constraint can always cite
  // SOMETHING — which is what stops the double from reproducing the pilot's
  // empty-`premiseIds` rejection on an opening turn with no facts yet.
  const premise = facts[0] ?? privates[0] ?? "p.self";

  const social = wantsSocial(request)
    ? {
        closedCommitments: [],
        social: {
          focalCandidates: [
            {
              seat: others[0] ?? 1,
              basisIds: [premise],
              claimedRole: null,
              influence: "medium" as const,
              credibility: "contested" as const,
              directive: "先按公开记录排掉挂过车的位置",
              reasonsToFollow: ["理由能对上裁判记录"],
              reasonsToChallenge: ["还没有结果检验过他"],
              conditionToReconsider: "他推的车挂了就重新看",
            },
          ],
          alignment: {
            stance: "conditional-follow" as const,
            focalSeat: others[0] ?? 1,
            proposition: "先排掉挂过车的位置，再谈别的",
            strongestSupport: "任务结果是公开的",
            publicAction: "公开说明我接住的是这一条，并按它投票",
          },
          coalitionPlan: {
            coordinateWith: others.slice(0, 2),
            proposedTeam: null,
            votingBloc: "undecided" as const,
            messageObjective: "让别人知道我依据的是哪一条记录",
            strongestDissent: "挂过车不等于车上的人都是坏人",
          },
        },
      }
    : {};

  // The claim contest. The double never claims anything itself — it plays the
  // most boring legal line, `stay-hidden` — but it DOES have to assess every
  // standing claimant, because `contestProblems` refuses a block that ignores
  // one. That is the check worth exercising on every turn of a scripted game.
  const claimants = standingClaimantsFrom(request);
  const mine = iAmClaiming(request, me);
  const contest = wantsContest(request)
    ? {
        contest: {
          ownClaimStrategy: {
            currentStatus: mine ? ("active" as const) : ("hidden" as const),
            intendedClaimRole: null,
            // Deliberately varied per decision. `contestProblems` refuses a
            // hidden-to-hidden update whose reasons are byte-identical to the
            // previous turn's, and a double that repeated itself would fail
            // that check on turn two — which is the check working, but it
            // would also stop every scripted game before the second speech.
            situationSpecificBenefit: `到目前为止公开信息量 ${request.user.length}，继续按记录说话`,
            situationSpecificRisk: `不进场就拿不到组织权（当前可引用 ${facts.length} 条事实）`,
            triggerToClaim: "有人推的车会直接决定胜负时",
            triggerToRetract: "我的说法和任务结果对不上时",
            candidatePairStory: "",
            leadershipObjective: "",
            concealmentCost: "别人可能先占住这个位置",
            consistencyObligations: [],
          },
          claimantAssessments: claimants
            .filter((s) => s !== me)
            .map((s) => ({
              claimantSeat: s,
              claimedRole: "percival",
              claimedOrImpliedPair: null,
              positiveCase: ["说的话目前还没被记录打脸"],
              negativeCase: ["还没有结果检验过"],
              contradictions: [],
              fulfilledPredictions: [],
              failedPredictions: [],
              currentAssessment: "plausible" as const,
              conditionToUpgrade: "他推的车成功",
              conditionToDowngrade: "他推的车挂了",
              premiseIds: [premise],
            })),
          rivalPlans: mine
            ? claimants
                .filter((s) => s !== me)
                .slice(0, 1)
                .map((s) => ({
                  rivalSeat: s,
                  whyTheirClaimCompetesWithMine: "我们站在同一个身份上",
                  attackCase: "他的时机和他给的车对不上",
                  expectedDefense: "他会说自己是后发才看清的",
                  myResponse: "要求他给出一辆能检验的车",
                  riskOfOverattacking: "打太狠会显得我在急着排除他",
                  distinctionTest: "两人各给一辆车，看结果",
                }))
            : [],
          alignment: {
            selectedClaimant: null,
            stance: "undecided" as const,
            proposition: "现在还分不开这几个声称",
            voteOrTeamConsequence: "按公开记录投，不因为声称改票",
            conditionToSwitch: "有一辆车的结果能分开他们",
          },
          publicClaimMove: {
            act: mine ? ("defend-own-claim" as const) : ("stay-hidden" as const),
            targetSeats: [],
            publicProposition: "先按公开记录排掉挂过车的位置",
            requestedTeam: null,
            requestedVote: "none" as const,
            evidenceIds: [premise],
            informationToConceal: "",
          },
        },
      }
    : {};

  return {
    ...social,
    ...contest,
    factsUsed: facts,
    claimsReliedOn: [],
    // Every claim is questioned by default, which is also the honest default:
    // recording a claim is not believing it.
    claimsQuestioned: claims,
    alternativesConsidered: ["按当前判断走", "再等一轮看结果"],
    selectedActionSummary: "按目前的硬事实选一个能被检验的动作",
    intendedPublicSignal: "让别人知道我依据的是哪些记录",
    updatedRolePlan: null,
    constraints: [
      {
        id: `k${me}`,
        statement: "挂过的车里至少有一个坏人",
        premiseIds: [premise],
        premiseLabels: ["任务结果"],
      },
    ],
    hypotheses: [
      {
        id: "h1",
        label: "坏人在早期的车上",
        evilSeats: others.slice(0, 1),
        rationale: "第一辆挂车的成员嫌疑更集中",
        standing,
      },
      {
        id: "h2",
        label: "坏人分散在两辆车",
        evilSeats: others.slice(0, 2),
        rationale: "两次失败可能由不同的人造成",
        standing,
      },
    ],
    seatReads: others.map((seat) => ({
      seat,
      standing,
      evidenceFor: [],
      evidenceAgainst: [],
      lastChangeReason: "",
    })),
    coverStory: "",
    claimPlan: "",
    nextTurnPlan: "继续看下一轮结果",
    newCommitments: [],
  };
}

/**
 * Answers the fused schema by delegating the ACTION to the existing legal-move
 * double and composing the cognition block itself.
 *
 * Delegating matters: the action half stays exactly what the legacy tests
 * already exercise, so a difference between the two paths is a difference in
 * cognition rather than in how the double plays.
 */
export function cognitiveClient(options: CognitiveClientOptions = {}): ModelClient {
  const inner = answeringClient();
  return {
    name: "cognitive-double",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      options.onRequest?.(request);
      const base = await inner.complete(request);
      const action = JSON.parse(extractJson(base.text)) as Record<string, unknown>;

      const generated = baseCognition(request);
      const cognition = options.mutate ? options.mutate(generated, request) : generated;

      const body =
        cognition === null ? action : { ...action, cognition };
      return { ...base, text: JSON.stringify(body) };
    },
  };
}

/** A double whose cognition is always structurally broken. */
export function brokenCognitionClient(
  defect: "missing" | "one-hypothesis" | "no-premises" | "contradictory",
): ModelClient {
  return cognitiveClient({
    mutate: (c) => {
      switch (defect) {
        case "missing":
          return null;
        case "one-hypothesis":
          return { ...c, hypotheses: [(c.hypotheses as unknown[])[0]] };
        case "no-premises":
          return {
            ...c,
            constraints: [
              { id: "k", statement: "他们都是坏人", premiseIds: [], premiseLabels: [] },
            ],
          };
        case "contradictory": {
          // The same claim both relied on and questioned: hedging dressed as
          // classification, which is what step 4 of the protocol forbids.
          const id = "c1:role";
          return { ...c, claimsReliedOn: [id], claimsQuestioned: [id] };
        }
      }
    },
  });
}

/* ── A double that actually fights over the identity ────────────────────── */

export interface ContestingClientOptions extends CognitiveClientOptions {
  /** Seats that claim Percival at their first speech opportunity. */
  readonly claimSeats?: readonly number[];
  /** Seats that publicly retract, once they have claimed and spoken again. */
  readonly retractSeats?: readonly number[];
  /** Claimants that attack a rival instead of merely defending. */
  readonly attackSeats?: readonly number[];
}

/**
 * A scripted table where several seats really do claim Percival.
 *
 * WHY THIS EXISTS SEPARATELY. The plain double plays the most boring legal line
 * — `stay-hidden`, forever — which is exactly right for testing plumbing and
 * useless for testing a CONTEST. Nothing in a game where nobody claims exercises
 * counterclaim status, the `contested` transition, retraction, the rival-plan
 * requirement, or the comparative-assessment check. So this one claims.
 *
 * It still plays badly on purpose: the arguments are placeholders. What it
 * exercises is the machinery around them — the referee's retraction rules, the
 * derived contest registry, the id minting, and every structural check in
 * `contestProblems`.
 */
export function contestingClient(options: ContestingClientOptions = {}): ModelClient {
  const claimSeats = new Set(options.claimSeats ?? []);
  const retractSeats = new Set(options.retractSeats ?? []);
  const attackSeats = new Set(options.attackSeats ?? []);
  const spoken = new Map<number, number>();
  const inner = answeringClient();

  return {
    name: "contesting-double",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      options.onRequest?.(request);
      const base = await inner.complete(request);
      const action = JSON.parse(extractJson(base.text)) as Record<string, unknown>;
      const me = seatOf(request);
      const isSpeech = typeof action.publicMessage === "string" && "claim" in action;

      let claiming = false;
      let retracting = false;
      if (isSpeech) {
        const turns = (spoken.get(me) ?? 0) + 1;
        spoken.set(me, turns);
        const standing = iAmClaiming(request, me);
        if (claimSeats.has(me) && !standing && turns <= 2) {
          action.claim = "percival";
          claiming = true;
        } else if (retractSeats.has(me) && standing) {
          // 退水 and a fresh claim in one speech is refused by the referee, so
          // the two branches are exclusive here too.
          action.claim = null;
          action.retractClaim = true;
          retracting = true;
        }
      }

      const cognition = baseCognition(request) as Record<string, unknown>;
      const contest = cognition.contest as Record<string, unknown> | undefined;
      if (contest) {
        const own = contest.ownClaimStrategy as Record<string, unknown>;
        const move = contest.publicClaimMove as Record<string, unknown>;
        const rivals = standingClaimantsFrom(request).filter((s) => s !== me);
        if (claiming) {
          own.currentStatus = "active";
          own.intendedClaimRole = "percival";
          own.candidatePairStory = "我看到的两个候选里，一个在前排一个在后排";
          own.leadershipObjective = "把车组在没上过失败车的位置上";
          move.act = rivals.length > 0 ? "counterclaim-percival" : "claim-percival";
          move.publicProposition = "我是派西维尔，下一车避开首轮失败位";
        } else if (retracting) {
          own.currentStatus = "retracted";
          move.act = "retract-claim";
          move.publicProposition = "我收回之前的声称，理由是我的说法和结果对不上";
        } else if (
          isSpeech &&
          iAmClaiming(request, me) &&
          rivals.length > 0 &&
          attackSeats.has(me)
        ) {
          move.act = "attack-rival-claim";
          move.targetSeats = rivals.slice(0, 1);
          move.publicProposition = "他的时机和他给的车对不上";
          // The move has to be VISIBLE. Writing `attack-rival-claim` into the
          // private block while the speech says nothing about him leaves the
          // table seeing no attack at all — which `contestProblems` refuses.
          action.stances = [{ seat: rivals[0], valence: -0.6, confidence: 0.5 }];
        }
      }

      const mutated = options.mutate ? options.mutate(cognition, request) : cognition;
      const body = mutated === null ? action : { ...action, cognition: mutated };
      return { ...base, text: JSON.stringify(body) };
    },
  };
}
