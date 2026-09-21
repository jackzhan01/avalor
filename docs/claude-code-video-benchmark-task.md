# Claude Code implementation brief: Avalon video annotation pilot

> Scope revision: Read `docs/claude-code-video-timeline-revision.md` first. It supersedes this brief's semantic speech annotation and output-format requirements. The current deliverable is original speech grouped by contribution, interleaved objective game events, a readable chronological transcript, and separate private identity labels. Do not improve or require semantic speech labels for this task.

## Assignment

Implement a working, local-first video-to-annotation pipeline for a small, carefully verified human Avalon benchmark. Codex will independently review the code and artifacts. Deliver executable code and measured pilot results, not just a design or mock provider.

The product and research are separate workstreams. This assignment belongs to research; it does not modify the frozen product inference or decision engines. The eventual CS580 project will cover a focused research question. This pipeline provides its data infrastructure and does not itself establish an AGT theoretical contribution.

Read `AGENTS.md`, `CLAUDE.md`, `PRODUCT-V1.md`, and relevant existing research code before editing. Preserve other agents' changes. Follow repository language conventions for user-facing messages; this implementation brief is intentionally English at the user's request.

## Source and verified access status

- Video: https://www.bilibili.com/video/BV19D7565EZg/
- BVID: `BV19D7565EZg`; AID: `116815779071505`; CID: `39424953454`; part: 1.
- Public metadata previously returned title `阿瓦隆高配局莫甘娜打法教学，这波谁分得清啊`, uploader `圆桌谜局`, duration 2044 seconds (34:04).
- Public metadata was accessible, but media download and playback have NOT been verified. Its subtitle list was empty; this does not imply absence of burned-in subtitles.
- User-suggested fallback: https://github.com/ScottSloan/Bili23-Downloader. Inspect current upstream documentation before using it; do not invent a CLI or API for it. Prefer an existing maintained downloader over reimplementing the platform.
- The user authorized an attempt to download this public video and process it locally. Do not bypass access controls, extract browser credentials, or start paid transcription/model calls without explicit cost authorization. Never expose signed media URLs, cookies, or credentials in tracked artifacts.

The supplied screenshot shows a speaker label at lower left (e.g. `6 小黑`), burned-in subtitles along the bottom, a small history board at upper right, and a spectator role roster at lower right. Actual layouts and transitions must be inspected in the downloaded video. Do not infer exact regions from this description alone or pretend the screenshot is available as a local file.

## Milestone scope

Build one end-to-end pilot, then report it for review:

1. Write the annotation specification, versioned schemas, and executable validators.
2. Acquire/probe the real video, or support a user-supplied local file if acquisition is genuinely blocked.
3. Inspect a small set of frames across the video and configure layout regions.
4. Process one complete discussion/team-selection/vote/mission-result cycle, preferably the first complete cycle. Record the chosen interval and why. If the edit omits a stage, report the gap rather than fabricating it.
5. Produce raw OCR, speaker-attributed transcript candidates, public event candidates, a separate private answer file, a review queue, and cutoff-based context exports.
6. Review the pilot against the source, record corrections separately, and report measured quality with denominators. Generate at least three meaningful cutoff examples if the source interval supports them.

Do not process the entire video expensively before this pilot is evaluated. Source acquisition/model-weight downloads may require network access; normal tests must run offline with no model downloads. If a dependency or source is blocked, continue the executable schema, fixtures, validators, and local-file workflow; identify the exact blocked stage. Synthetic fixtures cannot substitute for a claimed successful real-video pilot.

## Architecture and efficiency

Keep the implementation under `research/video-benchmark/`. Store media, extracted frames/audio, model weights, transcripts, identities, caches, and pilot artifacts under an ignored directory such as `research/data/video-benchmark/`. Commit only source, configs without secrets, documentation, and synthetic test fixtures by default.

Choose a practical media/OCR stack after checking installed tooling. FFmpeg/ffprobe plus Python/OpenCV and a maintained Chinese OCR implementation are reasonable; these are candidate choices, not claims about installed software. Python research dependencies belong in an isolated environment with pinned versions and documented Windows setup. Use npm for any Node dependencies; keep root production dependencies untouched. Do not add a web app or large orchestration framework.

Implement real commands for doctor, acquisition/local ingestion, layout inspection, extraction, validation, review export/correction import, sample generation, and report generation. Exact command names are your choice; document copy-pastable PowerShell examples.

- Use region-based frame differences to find candidate changes. Start with inexpensive sampling, refine around changes, and select clear stable frames for OCR. Record sampling rates and estimated timing precision. Include periodic guard samples so short captions and slowly changing content are not silently assumed covered.
- OCR only the relevant regions. Deduplicate temporal persistence, not globally repeated text. Keep separated repetitions and repetitions by different speakers.
- A visible speaker label identifies the featured speaker, not necessarily every overlapping voice. Flag offscreen interruptions and label transitions instead of assigning all audio to the label automatically.
- Use a real local timestamped ASR backend when feasible to cross-check captions and detect unsubtitled speech. Preserve disagreement; do not silently make ASR agree with OCR. Explicitly label subtitle-only output if ASR is unavailable.
- Caption appearance times are not word-level audio timestamps. Store their provenance and alignment status separately.
- Cache stages using content hashes, configuration, relevant tool/model versions, and correction revision dependencies. A changed crop must invalidate its OCR and downstream results. Re-running unchanged input must reuse expensive work.
- Preserve raw evidence and append-only/versioned human corrections. Detect stale correction targets after re-extraction. Never overwrite accepted corrections silently.
- Provide lightweight local review artifacts with timecodes, region crops, candidate text, discrepancy reasons, and editable correction records. A browser interface is not required. Keep full frames and private evidence separate from public-review artifacts.
- Report processed duration, sampled/selected frames, OCR calls, cache hits, ASR mode, elapsed time, review count, and any external usage. Do not route every frame to a general-purpose vision model.

## Data contracts

### 1. Raw evidence and transcript

Maintain stable source/evidence/utterance IDs and schema versions. Represent:

- source hash, video time range, extracted region, and evidence references;
- caption display interval and exact OCR text, including raw alternatives;
- speaker seat or null, original speaker label, and speaker attribution evidence;
- ASR text and audio timing separately from edited subtitle text;
- reviewed verbatim speech, if actually verified, separately from caption transcription;
- overlap, inaudible spans, uncertain numerals/negations, caption-only status, and review status;
- tool/model provenance and raw scores. OCR confidence is not a calibrated correctness probability; allow missing confidence.

Do not normalize ambiguous speech into a confident narrative. Preserve names, seat numbers, negation, and repeated statements. A sentence such as `然后点出了十号他可能是张莫甘娜` may report another player's opinion; do not automatically label it as the current speaker accusing seat 10.

### 2. Public game events

Use an independently versioned research schema, compatible in meaning with repository invariants. Implement a bounded, documented event set: actual team selection, seat-level vote observations, explicit vote outcome, mission outcome/fail count, public role claims/retractions, stance statements, and Lady announcements. Distinguish intended teams from actual teams and quoted stances from a speaker's own stance. Resolve quoted subjects only when evidenced.

- Facts that someone said something are separate from whether the statement is true.
- Lady public announcements are claims; actual privately observed alignment belongs to the private layer.
- Missing votes differ from explicitly unknown votes. Never infer authoritative pass/reject from a partial vector.
- Mission success never proves all passengers good. Fail counts constrain minimum evil presence, not exact identities.
- Preserve revisions and recantations. Stable sequence determines event order; do not renumber/reuse existing sequence values after corrections. Represent unresolved ordering explicitly instead of silently inventing it.
- Store video observation timing and conservative public-availability timing separately from sequence. Do not infer timing from final board layout or use wall-clock timestamps for ordering.
- Treat board OCR as snapshots, not ready-made events. Diff stable snapshots and retain conflicting interpretations for review. Future rows, delayed graphics, replays, commentary, and montage can invalidate apparent timing.
- Uncertain machine output remains a candidate. Only reviewed eligible records enter the default accepted dataset. Draft exports must be clearly marked and separate.

Full automatic semantic extraction of arbitrary Chinese dialogue is not required. Implement a useful bounded parser plus correction workflow. If a language-model extractor is optional, keep it behind an explicit adapter/configuration, with public-only inputs and no default paid calls. Document real coverage and unsupported cases.

### 3. Private labels and evaluation samples

Store final roles in a separately validated private artifact with per-seat source evidence, verification state, and unknown values where appropriate. Validate seat uniqueness and the confirmed role composition; never complete uncertain labels by guessing remaining roles.

Version 1 must support the public-observer perspective. Either implement tested player-specific views from explicitly authorized private knowledge or reject them clearly; do not claim support through a placeholder perspective flag.

Generate public context by an explicit cutoff sequence, subject to availability constraints. Include only completed utterances/evidence available at that cutoff; exclude a sentence spanning the cutoff rather than include future words. Prefer game-event cutoffs. Percentage cutoffs are optional, must have a defined denominator, and must not reveal final duration or future event counts to the evaluated agent.

Export X and Y separately. X contains confirmed rules, seat identifiers, and eligible public history. Y contains verified targets and label coverage for scoring. A partial identity roster permits partial scoring only. Identity prediction accuracy is not sufficient evidence of reasoning quality. Reserve fields for evidence references and logical constraint checks without presenting guessed reasoning annotations as ground truth.

Assign splits by whole game. All prefixes, camera versions, and edits of one game belong to the same split/group. Mark this first pilot as development data.

## Leakage controls: mandatory

1. Public extraction must receive only allowlisted regions. The spectator roster, role badges on physical seat cards, editorial role labels, and other answer-bearing overlays must be excluded or masked. The supplied screenshot shows a role word under the large seat number: masking only the right-hand roster is insufficient.
2. Public code paths must not load the private answer file. Private label extraction and scoring run separately. Do not pass full frames to a public multimodal extractor.
3. Track authoring access versus in-game public knowledge. Remove intros, role reveals, editorial spoilers, replays, and commentary from eligible history. Spoken role names during genuine player claims remain valid public speech; keyword deletion is not a leakage solution.
4. Agent-facing X must not contain the source title, uploader/video link, answer-bearing filenames, thumbnails, full video length, final outcome, or future labels. Use opaque IDs. Preserve source provenance only in evaluator-side manifests.
5. Sanitization cannot eliminate prior model memorization of publicly released games. Document this residual benchmark limitation without claiming perfect contamination prevention.
6. Test noninterference: changing the private role artifact or future suffix while holding the public prefix fixed must leave X byte-identical. Also test that changing private image-region pixels does not change public crops or public extraction inputs.

## Required verification

Write focused offline tests for behavior, not implementation mirroring:

- stable caption persistence, OCR jitter, brief captions, separated identical captions, and speaker changes;
- null speaker and overlapping speech; OCR/ASR disagreement survives review export;
- unresolved quotation attribution does not become a confident stance;
- incremental board updates, partial vote vectors, authoritative outcomes, and conflicting observations;
- cutoff-spanning speech, delayed result availability, future suffix changes, private-label changes, and private-region pixel changes;
- accepted versus draft records, immutable evidence, correction persistence, stale corrections, and cache invalidation;
- game-level split isolation, malformed labels, and export rejection for unsupported perspectives.

Measure pilot quality against a separately recorded reference review, not against OCR/ASR agreement. Include character errors where a reference exists, seat attribution errors/unknowns, omitted speech segments, event-field accuracy, and review burden. Report numerator/denominator, interval coverage, and whether measurements are before or after correction. Self-review is provisional; reserve final acceptance for Codex/user. If no reliable audio reference exists, do not report verbatim speech accuracy.

Document recall limits of low-frequency sampling and assess at least one short-caption/rapid-change interval with denser inspection. Low review-queue size alone does not prove high quality. Include a sample of apparently clean records in review.

Run the new offline suite, `npx tsc --noEmit`, and `npm run check:imports`. Run existing product/simulator suites if shared configuration or code changed. Do not run paid experiments, deploy, push, or merge. If you create a commit, stage only your own paths and rerun `npm run check:imports` after committing.

## Handoff for Codex acceptance

Create `research/video-benchmark/HANDOFF.md` containing:

1. Changed paths, architecture, dependency versions, and exact reproduction commands.
2. What really ran: download/probe, OCR, ASR, event extraction, corrections, sample export. Distinguish implemented, exercised, unverified, and blocked stages.
3. Local paths to ignored pilot artifacts, video hash, interval, layout config, and private/public review separation. Do not paste the role answers into a public transcript report.
4. Test results and measured pilot quality, with counts and timing uncertainty.
5. At least five timecoded review examples covering speaker attribution, a caption/ASR issue, a board transition, a cutoff boundary, and excluded spectator information where the source supports them. Explain absent categories.
6. Known failure modes, unresolved review items, and estimated human effort before expanding to the full video.

Completion requires a reproducible real pilot or a candid partial handoff identifying a concrete acquisition/dependency blocker. Mock OCR passing unit tests is not a completed video pipeline. Do not mark the dataset gold merely because validators pass.
