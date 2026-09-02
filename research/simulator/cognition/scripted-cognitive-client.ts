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
  // ONLY THE FACT LAYERS. Everything from the `cognition` instruction onward is
  // cut away before scraping, because that instruction teaches the notation by
  // SHOWING it — 「`[f12]`、`[f.fail1]`、`[c33:role]`、`[p.pair]` 这样的」 — at the
  // head of its own line, in the exact shape a real citable row uses.
  //
  // `[p.pair]` is not a placeholder. It is Percival's real pair id, and any
  // seat that copies it is citing a private id it does not hold. The double
  // did exactly that for four milestones; nothing failed, because an
  // unresolvable premise was silently unverified. 0.7.0 refuses it, the double
  // stopped being able to play, and that is how this was found.
  //
  // The prompt-side hazard is REPORTED, not fixed here: making the examples
  // unmistakable changes a frozen prompt, and that is a human decision.
  const cut = request.user.indexOf("### 除了动作，还要填一个 `cognition` 对象");
  const body = cut === -1 ? request.user : request.user.slice(0, cut);

  const ids: string[] = [];
  for (const match of body.matchAll(/`\[([^\]]+)\]`/g)) {
    const id = match[1];
    // The legend's own placeholders — `[f…]`, `[c…]` — are not ids. A real id
    // is ASCII; the ellipsis is what tells the two apart.
    if (!/^[!-~]+$/.test(id)) continue;
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

/**
 * A structurally legal cognition block for a given request.
 *
 * EXPORTED for tests that need a valid block to fold, and only for that. Every
 * required field of every version is present, so a test about ONE field does
 * not have to hand-maintain the other forty — which is how a fixture drifts
 * out of sync with the parser and starts testing the fixture.
 */
export function baseCognition(request: ModelRequest): Record<string, unknown> {
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


/* ── The 0.6.0 vote analysis ────────────────────────────────────────────── */

/**
 * A structurally legal `voteAnalysis`, read out of the rendered prompt.
 *
 * READ FROM THE PROMPT, not from game state the double does not have. That is
 * the same discipline `renderedIds` follows: if the tables ever stop printing
 * what a real model would need, the double stops being able to answer and the
 * tests go red — which is the failure mode worth catching.
 */
function voteAnalysisFor(request: ModelRequest): Record<string, unknown> {
  const user = request.user;

  const streakMatch = /连否 (\d+) 次/.exec(user);
  const rejectionStreak = streakMatch ? Number(streakMatch[1]) : 0;
  // Detected the same way the checker detects it: a mission_result line in
  // the referee's own table. A negative check on the placeholder text would be
  // one rendering change away from disagreeing with the check it must match.
  const resolved = /第 \d+ 轮 (?:成功|失败)/.test(user);

  // The mission and attempt currently on the table, and the team proposed for
  // it — both printed in the referee's own fact tables.
  const nowMatch = /第 (\d+) 轮，第 (\d+) 次点车/.exec(user);
  const mission = nowMatch ? nowMatch[1] : "1";
  const attempt = nowMatch ? nowMatch[2] : "1";
  const proposal = new RegExp(`R${mission}#${attempt} \\\\d+号发车 ([\\\\d、]+)号`).exec(user);
  const proposed = proposal ? proposal[1].split("、").map(Number).sort((a, b) => a - b) : [];

  // The most recent failed mission's team, so a repeat can be named as one.
  let lastFailed: number[] = [];
  for (const m of user.matchAll(/第 (\d+) 轮 失败　上车 ([\d、]+)号/g)) {
    lastFailed = m[2].split("、").map(Number).sort((a, b) => a - b);
  }

  const repeats =
    lastFailed.length > 0 &&
    lastFailed.length === proposed.length &&
    lastFailed.every((x, i) => x === proposed[i]);

  const fit = !resolved ? "no-constraint-yet" : repeats ? "repeats-failed-team" : "avoids";

  return {
    newConstraint: resolved ? "上一轮挂掉的车里至少有一个坏人，这条约束还没被拆开" : "",
    constraintFit: fit,
    implicatedRiders: [],
    leaderExplanation: "",
    informationFromApproving: "放过去可以用结果检验这几个人",
    rejectionStreak,
    hammerRisk:
      rejectionStreak >= 3 ? "再否下去这一轮会直接判坏人赢，代价太大" : "",
    // The action half is produced by the legal-move double; this is filled in
    // to match it by `disclosureClient` below.
    choice: "approve",
    reason: "按公开记录，这辆车目前没有比它更该过的替代车",
    evidenceIds: [],
  };
}

/* ── A two-stage double, for `prompt-0.5.0` ─────────────────────────────── */

export interface DisclosureClientOptions extends CognitiveClientOptions {
  /**
   * Seats whose PLANNER tries to publish the pair through the envelope.
   *
   * The point of the test is not that a planner would do this by accident. It
   * is that the envelope is model-written, so an adversarial or confused
   * planner is a case the firewall has to survive rather than assume away.
   */
  readonly leakingPlannerSeats?: readonly number[];
  /**
   * Seats whose SPOKESPERSON emits the forbidden sentence anyway.
   *
   * Impossible through the real path — the wording model never receives the
   * pair — so the payload is passed in. It exercises the message gate, the
   * byte-identical retry and the terminal `disclosure_invalid` state.
   */
  readonly leakingSpokespersonSeats?: readonly number[];
  /** The literal payload a leaking stage writes. */
  readonly payload?: string;
  /** Seats that claim Percival at their first speech. */
  readonly claimSeats?: readonly number[];
  /** Fired with every spokesperson request, so a test can read the prompt. */
  readonly onSpokespersonRequest?: (request: ModelRequest) => void;
}

/** Is this the wording leg? Decided by the schema name, which the builder owns. */
export function isSpokespersonRequest(request: ModelRequest): boolean {
  return request.format.name.startsWith("avalon_say_");
}

/**
 * A table that answers BOTH legs of a `prompt-0.5.0` speaking turn.
 *
 * Delegates the action half to the same legal-move double every other test
 * uses, so a difference between the one-stage and two-stage paths is a
 * difference in the split rather than in how the double plays.
 */
export function disclosureClient(options: DisclosureClientOptions = {}): ModelClient {
  const leakingPlanners = new Set(options.leakingPlannerSeats ?? []);
  const leakingSpokespersons = new Set(options.leakingSpokespersonSeats ?? []);
  const claimSeats = new Set(options.claimSeats ?? []);
  const payload = options.payload ?? "7、9一梅林一莫甘娜";
  const spoken = new Map<number, number>();
  const inner = answeringClient();

  return {
    name: "disclosure-double",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      options.onRequest?.(request);

      if (isSpokespersonRequest(request)) {
        options.onSpokespersonRequest?.(request);
        const field = request.format.name.includes("evil_discuss")
          ? "message"
          : "publicMessage";
        // The spokesperson has no seat number in its schema, so a leaking one
        // is identified by the seat printed in the public view.
        const me = spokespersonSeatOf(request);
        const text = leakingSpokespersons.has(me)
          ? payload
          : "按公开记录，这辆车我反对，建议换成前面提过的那一组。";
        return {
          text: JSON.stringify({ [field]: text }),
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
          latencyMs: 0,
          cached: false,
          modelReturned: "disclosure-double",
          status: "completed",
        };
      }

      const base = await inner.complete(request);
      const action = JSON.parse(extractJson(base.text)) as Record<string, unknown>;
      const me = seatOf(request);
      const schemaText = JSON.stringify(request.format.schema);
      const wantsIntent = /"communicationIntent"/.test(schemaText);

      // 0.6.0 asks for a six-question vote analysis alongside the vote.
      if (/"voteAnalysis"/.test(schemaText) && typeof action.choice === "string") {
        action.voteAnalysis = { ...voteAnalysisFor(request), choice: action.choice };
      }
      // …a bounded candidate ranking alongside an assassination target.
      if (/"assassination"/.test(schemaText) && typeof action.target === "number") {
        // The roster is rendered in this phase, so the double reads it rather
        // than guessing. Naming somebody on it is LEGAL and would be recorded
        // as a strategic error; the double simply plays the game properly.
        const rosterLine = /坏人这一边的确切身份[^：]*：([^。]*)/.exec(request.user);
        const known = new Set<number>([me]);
        for (const m of (rosterLine?.[1] ?? "").matchAll(/(\d+)号/g)) known.add(Number(m[1]));
        // The legal-move double picks any seat but itself; a seat this Assassin
        // already knows is evil is legal by the rules and a losing move. Under
        // 0.6.0 the roster is rendered, so the double plays it properly.
        const legal = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((x) => !known.has(x));
        const target = legal.includes(action.target as number)
          ? (action.target as number)
          : (legal[0] ?? (action.target as number));
        action.target = target;
        const other = legal.find((x) => x !== target);
        // 0.7.0 requires the Lady analysis for anybody who announced a result.
        // The double reads WHO announced out of the rendered public log rather
        // than guessing, which is the same source `assassinationProblems` uses.
        // Matched against the line the fact table actually prints:
        // 「- 9号 验了 1号，**公开宣称**「good」…」. A looser pattern missed it
        // and the double then answered `heldLady: false` for a seat that had
        // announced — refused by the very check this milestone added, which is
        // the check working.
        const announcers = new Set<number>();
        for (const m of request.user.matchAll(/(\d+)号 验了 \d+号/g)) {
          announcers.add(Number(m[1]));
        }
        const wantsLady = /"accurateBeforeLady"/.test(schemaText);
        const one = (seat: number) => ({
          seat,
          signals: ["accurate-rejection"],
          evidence: ["公开票型上多次避开了后来挂掉的车"],
          // Never "he had Lady information" alone — that is the one shape
          // 0.7.0 refuses, and the double must not model the mistake.
          counterEvidence: ["他这些判断在拿到女神之前也没有更早出现过"],
          evidenceIds: [],
          ...(wantsLady
            ? {
                lady: {
                  heldLady: announcers.has(seat),
                  announced: announcers.has(seat),
                  accurateBeforeLady: [],
                  explainedByLady: [],
                  beyondLadyResult: [],
                  convenientCover: announcers.has(seat),
                  contradictsRoster: false,
                },
              }
            : {}),
          confidence: seat === target ? 0.6 : 0.4,
        });
        action.assassination = {
          candidates: [one(target), one(other ?? (target === 1 ? 2 : 1))],
          target,
          why: "公开记录上他比第二名更早给出正确排除方向",
          whatWouldChangeIt: "如果他后来支持过一辆挂掉的车，就换人",
        };
      }
      // …and a bounded coordination record alongside a mission card.
      if (/"coordination"/.test(schemaText) && typeof action.card === "string") {
        const designated = /\*\*← 指定出牌人\*\*/.test(request.user)
          ? request.user.includes("你是这一轮的指定出牌人")
          : false;
        const failsMatch = /需要 \*\*(\d+) 张失败票\*\*/.exec(request.user);
        action.coordination = {
          designated,
          failsRequired: failsMatch ? Number(failsMatch[1]) : 1,
          card: action.card,
          intent: action.card === "fail" ? "sabotage" : "conceal",
          evidenceIds: [],
        };
      }

      if (wantsIntent) {
        const isSpeech = "claim" in action;
        let claiming = false;
        if (isSpeech) {
          const turns = (spoken.get(me) ?? 0) + 1;
          spoken.set(me, turns);
          claiming = claimSeats.has(me) && turns === 1;
        }
        // The planner's schema has no message field under 0.5.0. Removing it
        // here mirrors what the provider's strict schema would do.
        delete action.publicMessage;
        delete action.message;
        if (isSpeech) action.claim = claiming ? "percival" : null;
        // 0.7.0 asks WHY a claim is being made. The double claims once and
        // never repeats, so the only honest answer is `first-claim` — and null
        // whenever it is not claiming at all.
        if (isSpeech && /"claimPurpose"/.test(schemaText)) {
          action.claimPurpose = claiming ? "first-claim" : null;
        }
        // 0.7.0 also asks WHICH public events made a standing claim ambiguous.
        // The double never re-claims, so the honest answer is always null.
        if (isSpeech && /"ambiguityEventIds"/.test(schemaText)) {
          action.ambiguityEventIds = null;
        }

        const leaking = leakingPlanners.has(me);
        action.communicationIntent = {
          channel: "table-public",
          publicGoal: leaking ? payload : "让牌桌换一辆车",
          targetSeats: [],
          selectedClaimAction: claiming ? "claim-percival" : "stay-hidden",
          requestedTeam: null,
          requestedVote: "none",
          publicBasisIds: leaking ? ["p.pair", "p.self"] : [],
          publicProposition: leaking
            ? payload
            : "现在还没有任何一辆车拿到过可以核对的安全依据",
          desiredTableEffect: leaking ? payload : "先把比较办法定下来",
        };
      }

      const generated = baseCognition(request);
      const cognition = options.mutate ? options.mutate(generated, request) : generated;
      const body = cognition === null ? action : { ...action, cognition };
      return { ...base, text: JSON.stringify(body) };
    },
  };
}

/** The seat a spokesperson prompt is speaking for. Public, and printed. */
function spokespersonSeatOf(request: ModelRequest): number {
  const match = /## 你是 (\d+)号的发言/.exec(request.user);
  return match ? Number(match[1]) : 0;
}
