# Claude Code revision brief: chronological human Avalon game record

> 最新用户确认的模型输入与交付格式见 [按组队 block 的 input–label 修订任务](./claude-code-video-agent-pair-revision.md)。该任务取代本文的用户呈现与模型输入格式要求；本文保留作为 v2 审计时间线的历史任务书。

## Authority and corrected scope

This brief supersedes the semantic-annotation and output-format requirements in `docs/claude-code-video-benchmark-task.md`. The user clarified and approved the scope below. Keep applicable repository invariants and the original brief's provenance, cache, correction, and leakage protections.

The deliverable is a chronological record of the real game: original player speech interleaved with objective public game events, plus a separately stored answer roster. The evaluated agent must interpret the speech itself.

Implement this revision in `research/video-benchmark/`, exercise it on existing pilot artifacts first, then extend it to the full downloaded video. Preserve existing raw observations, reference reviews, corrections, and prior outputs. Use versioned outputs and explicit migration rather than silently replacing previously reviewed records. Do not commit, push, deploy, or modify production code.

Read `HANDOFF.md`, `SPEC.md`, `README.md`, the existing code, and repository instructions. The user-facing handoff and rendered dialogue remain Chinese; this brief is English as requested.

## What is in scope

1. Burned-in human subtitles transcribed accurately and attributed to the speaker's seat, grouped into speech turns.
2. Actual team selections, leader/mission/attempt context where evidenced, per-seat votes, explicit pass/reject outcomes, mission outcomes and fail counts where visible.
3. Other objective public actions needed for the actual game, such as Lady token transfer or assassination, only when evidenced. Spoken Lady announcements remain original speech; do not promote their claimed alignment to a verified fact.
4. Final per-seat identities, stored separately for evaluator use with source and verification status.
5. One ordered public timeline, an easy-to-read Chinese transcript rendered from that timeline, and cutoff-based agent inputs derived from the same data.

## What is out of scope

Do not extract or score semantic speech labels such as support/accusation, claimed role, denial of role, intended team, quoted stance, inferred intent, logical explanations, or inferred alliances. Preserve all such language verbatim inside speech records. Do not replace dialogue with summaries, sentiment, structured reasoning, or cleaned-up paraphrases.

An actual formal team selection is in scope. A player's tentative team mentioned in speech remains speech unless independent public evidence confirms the formal selection. Do not require manual semantic labeling to accept a transcript.

The prior low role-claim and stance recall figures are not defects against this revised scope and must not drive implementation or acceptance. Preserve historical semantic artifacts for reproducibility; remove semantic extraction from the default new pipeline and exclude these events from new timeline/X exports. Compatibility may be retained explicitly, but do not spend time improving that parser.

## Existing implementation points to inspect

- `vbench/utterances.py`: `build_utterances` currently emits predominantly caption-level records. Retain these as evidence; add a derived speech-turn assembly stage.
- `vbench/pipeline.py` and `vbench/speech_events.py`: disconnect default semantic extraction without losing board extraction or invalidating unrelated reviewed data.
- `vbench/views.py`: currently builds separate utterance/event files. Add a unified timeline derived from corrected records.
- `vbench/samples.py`: `build_x` currently copies public events without an objective-event allowlist. Prevent old semantic labels from entering revised X.
- `vbench/export.py`, schemas, CLI, reporting, tests, and documentation: update together and version changed contracts.
- Inspect sequence allocation before adding turn grouping. Do not reuse or renumber existing ledger sequences. New presentation order must have explicitly different semantics from immutable source sequences.

## Speech-turn assembly

A speech turn is one continuous contribution by one speaker, often spanning many subtitle cards. It is not all speech by the same seat in a mission.

Each turn/turn-part needs a stable ID, seat or null, start/end video time with a documented time basis, original joined text, ordered subtitle segments, source record references, and review/coverage flags. Each segment preserves its source ID, original text and timing. Machine OCR and reviewed caption text remain distinguishable in evidence. Do not claim reviewed captions are audio-verified verbatim speech.

- Merge consecutive eligible subtitle segments belonging to the same contribution. Use observed speaker transitions, timing, gaps, and editorial transitions; do not merge solely by seat equality or mission number.
- Keep a speaker's later contribution separate after another person speaks. A -> B -> A cannot become one A paragraph followed by B.
- Do not infer a turn boundary from every subtitle replacement or infer continuity across a long gap, montage, missing label, or unknown speaker. Provide reviewable boundary corrections for uncertain cases.
- Preserve interjections, repeated words actually spoken, negation, numerals, and the order of subtitle wording changes. Deduplicate only persistence of the same displayed subtitle, not distinct similar sentences.
- Unknown and overlapping speech must remain visible as uncertainty; do not assign an offscreen interruption to the featured speaker automatically.
- If a public event occurs during a long contribution, represent ordered turn parts with a shared parent ID, or another explicit equivalent that preserves the event's actual position. Do not move that event after the entire speech or duplicate words around it.
- Joined text must be traceable to segments with no lost or duplicated accepted content. Document the separator policy. Do not invent punctuation that changes meaning.
- ASR is supplementary evidence. Keep the main caption transcript caption-faithful. Reviewed unsubtitled speech may be included with its source clearly marked; unreviewed ASR belongs to draft/review only. Caption coverage is not proof of complete spoken-audio coverage.

## Objective events and chronology

Use one discriminated timeline with speech and objective event records. Record order follows actual supported chronology, not a fixed discussion/team/vote template. A rejected team leads to another discussion/attempt within the same mission. A passed team can lead to mission execution and resolution. Mid-discussion formal team selection belongs at its actual observed position.

Maintain mission number and team-selection attempt separately. Unknown context remains unknown. Confirm house rules from evidence or explicitly supplied rules. Do not silently impose the simulator's standard five-rejection rule: this video's pilot reports a third-attempt forced team.

Retain full seat-level vote coverage semantics: missing observation differs from explicitly unknown. Store explicit pass/reject separately; never derive authoritative outcomes from a partial vector. Do not invent votes for a forced team. Distinguish unknown fail count from zero. Keep conflicts and missing records reviewable.

Preserve two distinct concepts: event occurrence order/time where supported, and when its content becomes available in the edited source. The board can backfill several rows later. Do not backdate such content into earlier evaluation prefixes. If relative historical order is supported, retain it as context; the availability-aware timeline must show the later observation and its retrospective status.

The known pilot includes a cut that omits the third team discussion and first mission execution; board rows appear around 579-583 seconds and speech confirms success later. Show an explicit coverage gap and late-reported facts. Do not call this an uninterrupted complete cycle or invent the missing discussion, votes, or reveal time.

## Output contract and readable layout

Provide three clearly separated artifacts under the ignored data directory:

1. A versioned canonical public game JSON with a single ordered `timeline`, confirmed rules, coverage information, and references for source-side audit. Timing and source evidence may exist in this archival artifact.
2. A Chinese readable transcript generated from that JSON, preferably UTF-8 Markdown for a minimal dependency-free first version. Use mission/attempt headings where supported, speaker/turn labels and time ranges, original speech paragraphs, and visually distinct concise blocks for actual teams, vote vectors/outcomes, and mission results. Show missing/unknown values and editing gaps explicitly. Keep ground-truth identities out of this public transcript. Do not build a separate website or production UI.
3. A private role roster and evaluator-side labels, separate from public timeline/transcript and agent inputs. Include verification provenance and unknowns. Check end-of-video reveals against the existing producer roster when available; disagreement requires review, not silent resolution.

Generate model-facing X by a sanitized projection of the public timeline, not an independent reconstruction or the human-readable audit document. Keep source links, private roster, title, thumbnails, video fingerprints, answer metadata, and future context out of X. Do not include semantic labels. Preserve legitimate player statements containing role names.

All renderers and sample exporters must consume the same canonical content so the readable transcript and JSON cannot disagree. Do not put identities into hidden HTML, expandable sections, or embedded script data in a public artifact.

Cutoff processing must operate on eligible underlying segments/events before turn assembly (or prove an equivalent prefix-safe algorithm). Appending future same-speaker subtitles must not alter an earlier X's IDs, text, grouping, or membership. Do not calculate a full future turn and then remove earlier available words because its final end time crosses the cutoff. Include only complete eligible segments at the cutoff, marking a partial contribution if needed without revealing its future extent. Speech containing later public reveals/postgame answers must not enter identity-inference prefixes.

## Implementation and real-video work

1. Preserve the old pilot artifacts and report. Implement and test the new schema, turn assembly, timeline, readable renderer, and X projection.
2. Rebuild the 0-637s pilot using existing accepted caption corrections and objective event corrections. Do not require new OCR/ASR runs merely for output-format changes. Exclude semantic corrections from new delivery while preserving their historical records.
3. Review several complete multi-caption turns and the known board transitions/cut. Produce a readable pilot that the user can inspect immediately.
4. Extend extraction and the new presentation to the entire downloaded video using cache reuse. Inspect layout changes and the boundary between live game and postgame material. Review transcript attribution, grouping, and objective events throughout. Avoid sequential full-frame model viewing; reuse local OCR, region crops, contact sheets, and cached ASR.
5. If transcript quality fixes are needed (single-character OCR fallback or destructive fuzzy merges), version them, preserve the old measurements, and migrate/revalidate corrections explicitly. This is development data, so improvements are allowed; report new results as a separate run.
6. Export whole-source draft coverage and accepted public-game coverage separately where unresolved items remain. Report exact unreviewed intervals/items. Do not label an artifact complete/verified if only the pilot is reviewed, or claim the edited upload captures speech it omitted.

The goal is the full available public game record. If an actual blocker prevents full acceptance, deliver the working pilot revision and full available draft with a precise blocked-work account. Do not stop at a schema example when the real source and local tools are available.

## Acceptance tests and handoff

Run focused offline tests including:

- multiple subtitle cards become one correct speech contribution;
- A -> B -> A remains chronological, including an interruption and resumption;
- missing label, gap, overlap, and same-seat speech across mission/attempt boundaries;
- repeated real text is preserved; persistent display is not duplicated;
- every accepted eligible segment occurs exactly once in the full timeline;
- public event during speech appears at the correct position without missing/duplicated words;
- rejected teams, a forced team without a vote, missing vote entries versus unknown, and unknown versus zero fail counts;
- late board updates and missing footage do not expose future outcomes to earlier X;
- private-label and future-suffix noninterference, including appending to the same speaker's ongoing turn;
- semantic events from legacy data never enter the revised timeline, readable transcript, or X;
- readable output and JSON contain the same ordered original speech and objective facts;
- reruns preserve corrections, source IDs/sequences, and cache behavior.

Run the revised offline suite, `npx tsc --noEmit`, and `npm run check:imports`. Run broader existing tests only if shared code/configuration changes justify them. No paid API calls are authorized by this revision.

Update `SPEC.md`, `README.md`, and `HANDOFF.md` to document the revised scope. Preserve the previous handoff as a historical version before replacing it. Report caption fidelity, attribution, turn-boundary quality, event completeness/field accuracy, timing uncertainty, full-video coverage, and review burden. Do not use semantic extraction recall as an acceptance metric or copy the former 6-7 hour estimate, which included out-of-scope semantic labeling.

In the handoff, give exact local paths and reproduction commands for the full timeline JSON, readable transcript, private labels, cutoff examples, and unresolved review queue. Include several real multi-caption turns and objective-event transition timecodes for Codex to inspect, without placing identity answers in the public report. Clearly distinguish machine candidates, provisional self-review, and independent verification.
