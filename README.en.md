<p align="center">
  <img src="figure/hero.webp" alt="Avalor" width="100%">
</p>

<h1 align="center">Avalor · An Avalon Notebook with an AI Advisor</h1>

<p align="center">
  The screen is laid out the way you're sitting — then an AI that actually read the game talks you through it.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/AI-board%20read%20%2B%20speech%20outline-8A63D2" alt="AI board read and speech outline">
  <img src="https://img.shields.io/badge/Next.js-15-000?logo=nextdotjs&logoColor=white" alt="Next.js 15">
  <img src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/storage-IndexedDB%20·%20local--first-2ea44f" alt="Local first">
  <img src="https://img.shields.io/badge/tests-227%20passing-2ea44f" alt="227 tests">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

> The app itself is in Chinese, and so is everything the AI writes back.

---

## What this is

A 9–10 player game of Avalon runs 45–90 minutes. No one can hold all of it at once: who vouched for whom, who threw whom under the bus, when someone's story changed, who proposed which team, who approved it, which missions blew up. What you can't remember, you end up playing on vibes.

Avalor solves that in two layers:

> **Below — turn the table into structured data.** Two taps per fact, without breaking the rhythm of the game.
> **Above — hand that data to an AI, in one tap.** A read on every seat, or your next speech laid out for you.

**The two layers are the same idea from two sides.** Recite "9 players, round 4, I think seat 3 is off" to any chatbot and all you get is conversation — it has nothing to work with. Avalor's AI is handed every team, every seat-level vote, the gap between what someone said they'd do and what they actually proposed, and every change of heart. **The finer your notes, the sharper it reads. Recording isn't the point — it's the fuel.**

Here's the recording layer —

<table>
<tr>
<td width="25%"><img src="figure/shot-table.webp" alt="The round table with the guess layer switched on" width="100%"></td>
<td width="25%"><img src="figure/shot-express.webp" alt="The panel for recording what one player said" width="100%"></td>
<td width="25%"><img src="figure/shot-players.webp" alt="The players page and the opinion matrix" width="100%"></td>
<td width="25%"><img src="figure/shot-timeline.webp" alt="The full event timeline for one game" width="100%"></td>
</tr>
<tr>
<td valign="top"><b>The table is the interface</b><br><sub>Real seating order, with leader / Percival / Lady badges drawn right on the seats. The guess layer is yours alone.</sub></td>
<td valign="top"><b>Tap someone, log what they said</b><br><sub>Reads, intended teams and Percival claims stored apart. Two taps. Public and private split on screen.</sub></td>
<td valign="top"><b>Every read in one grid</b><br><sub>Row = who's talking, column = who about. "·" means never spoke up — not the same as an explicit 3.</sub></td>
<td valign="top"><b>A timeline you can't corrupt</b><br><sub>Proposals, seat-level votes and reads in order. Tap any entry to fix or delete it.</sub></td>
</tr>
</table>

Each of those, in turn.

### 1. The round table is the interface, so nothing needs translating in your head

You're pinned to the bottom of the circle (6 o'clock) and everyone else sits in their real order. **Nobody at a table thinks "player 3" — they think "second to my left."** The circle maps onto the picture already in your head. One table, four modes:

| What you're doing | Tapping a seat means |
|---|---|
| Default | Pick someone, log what they said |
| Reads | Pick who they're talking about, then rate it 1–5 |
| Proposals / intended teams | Pick who's on the team |
| Votes | Each tap cycles approve / reject / unsure / not recorded |

It doubles as the board state: the leader wears a badge, Percival claims are marked, players on the team light up, and **the spatial pattern of a vote is visible at a glance** — whether the approvals were all sitting together is something a vertical list can never show you.

### 2. "Who said what" as structure, not as a wall of notes

Three kinds of public expression hang off each player:

- **Reads** — their 1–5 stance on someone else, logged in two taps, no save button
- **Intended teams** — who they *say* they'd take, **stored separately from what they actually proposed**, so "said 1/3/5, proposed 2/4/6" jumps out
- **Percival claims** — whether they've claimed the role

On the players page those add up to an **opinion matrix**: row is who's talking, column is who about. Who's getting piled on, who never commits, which pair keeps vouching for each other — all without scrolling the timeline. Cells where someone changed their mind carry a marker.

On top of that, the game's own **actions**: proposals, full seat-level vote records, mission outcomes and fail counts, plus a free-text note to catch whatever the structure can't. At the end there's the assassination and the reveal. By then a game is **a full report you can replay line by line**: who started acting from which round, which claim turned out to be real information, who actually cast that one rejection.

### 3. The private layer is separate, and it's yours alone

There's a layer **only you can see**: your own role, the vision that role grants you, and your guesses about everyone. Vision and guesses are two independent switches, **both hidden by default** and reset every time you open the page — so when you glance down to take a note, the person next to you sees nothing.

It's separate in the data too: private events are tagged as such, never enter the timeline, and can be stripped out wholesale. So **when you share a game with the group for review, your role and your reads don't travel with it** — the public export contains only what everyone at the table heard and saw.

### 4. Event-sourced, local-first, and incomplete data is always legal

A game is an immutable event log, and every piece of state on screen is derived from it by **pure functions**. Changed opinions don't overwrite history, pass/fail is never inferred from votes, and half-remembered votes are recorded as exactly that. Everything lives in the browser (IndexedDB) — no accounts, **the notebook works with no network at all**. It only goes online when you press an AI button.

---

## The AI advisor: read the board, or draft your speech

Two buttons under the table.

**"Analyze"** — a read on every seat, each with a one-line reason grounded in a specific team or vote, plus how confident it is (high / medium / just guessing), and a few key takeaways. **It branches on your role**: telling Merlin who the bad guys are is worthless — he already sees them. What keeps him up is whether *he's* been made.

| Your role | What it mainly answers |
|---|---|
| Merlin | Who's Percival, which one's the Assassin, and **have you exposed yourself** |
| Percival | Of the two you can see, which one is actually Merlin |
| Loyal Servant | Who's evil, and who looks most like Merlin (spot him, don't out him) |
| Evil team | Where Merlin is, who Percival is, how burned your teammates are |
| Assassin | All of the above, plus "if you had to shoot right now, who" |

**"Draft my speech"** — an outline, not a script. Four to six talking points in the order you should make them, a one-line stance, and the column that matters most: **what not to say this round**. Steer it with a note like "I want to go after seat 4," and save the result to your scratchpad.

Both run on the same input: a Chinese briefing rendered from the event log by `briefing.ts`, a pure function that refuses to collapse distinctions — never-spoke-up vs. explicitly neutral, intended team vs. actual proposal, what the Lady of the Lake announced vs. what you actually saw, and the full chain behind every changed opinion. The prompt pins down the rules models most often get wrong, and tells it to say "unclear" when the evidence isn't there.

### This is the only thing that sends data anywhere

The cost, stated plainly: these two buttons send **this game's record** to a model provider, and that **includes your role, your vision and your guesses** — without them it can't help Merlin find the Assassin. So:

- The first press stops and lists exactly what's about to leave; nothing goes until you agree
- The result page can always be expanded to show **the exact text that was sent**, word for word
- Don't press it and not a byte moves. With no API key configured the feature simply doesn't exist, and the rest of the app stays fully offline
- Results never write back into your record — unless you save one to the scratchpad yourself

---

## Starting a game

You land on the cover; one tap gets you to the menu. Three steps to start: **player count → tap yourself → tap the first leader**. The role line-up follows the official table for that count and is confirmed at setup.

---

## Data rules we won't bend

These are the foundation of the data model, and where the tests concentrate:

1. **Blank ≠ neutral.** Never having commented and explicitly saying "can't tell" (3) are different facts. Blanks are never auto-filled to 3.
2. **Changing your mind doesn't erase history.** If 3's read on 6 goes 4 → 5 → 2, all three entries survive and the full arc is visible in the timeline.
3. **A vote is not a tally.** A 6-4 pass means something completely different depending on *which* six. Full seat-level vote vectors are stored, and "recorded as unsure" and "never recorded" are distinct states.
4. **Pass or fail is whatever you recorded — never inferred from the votes.** Conclusions reverse-engineered from a half-recorded vote are wrong with great confidence.
5. **Incomplete data is always legal.** Half a vote you caught, a fail count you lost track of — record it anyway.
6. **Ordering follows `sequence`, never timestamps.** Device clocks jump, and sorting by time would quietly scramble a whole game.
7. **The private layer must be strippable in one piece.** Role, vision and guesses live apart and come out cleanly in a public export — they never bleed into the public event stream.

---

## Architecture

```
src/lib/
  types/       events and derived types (three kinds: action / expression / private)
  rules/       official player-count table, the two-fail rule on round 4, per-role vision
  selectors/   all derivation (pure functions, unit-testable)
    derive-timeline.ts   ← the core fold: phase, current team, round number, leader
    private.ts           ← the private layer, strictly isolated from the public one
  events/      event add/edit/delete and cascade rules
  store/       Zustand (optimistic updates) + a serialized Dexie write queue
  db/          IndexedDB (the only place allowed to import dexie)
  stats/       personal win-rate stats
  fixtures/    test fixture builders
  ai/          the optional AI layer, fully decoupled from everything above
    briefing.ts          ← pure function: event log → a Chinese briefing a model can read
    prompts.ts           ← prompts, branching on the player's role
    parse.ts             ← lenient parsing of model output
src/app/api/ai/route.ts  ← the only place holding an API key (server side)
```

Three calls worth explaining:

- **Phase is derived, not maintained.** `deriveTimeline` produces every piece of structural state in one O(n) fold, with the phase computed from declarative invariants ("an unvoted team exists ⟺ voting"). A pre-scan settles each team's authoritative vote first, so the fold never has to undo an effect it already applied — which is what makes re-recording a vote a safe operation.
- **The leader is anchored to the last known fact, not a modulo counter.** One manual leader correction and a counter is permanently off by one with no way to recover. Seat numbering direction and leader rotation direction stay two separate settings, because a table can number one way and pass the other.
- **The AI's input is the output of a pure function.** `buildBriefing` renders the event log into a briefing in the browser; the server route only forwards it with a key attached and never touches the event log. That keeps the prompt's input unit-testable (there are tests guarding exactly those never-spoke-up-≠-neutral distinctions) and lets "show me what was sent" produce the identical bytes.

---

## Development

```bash
npm install
npm run dev                  # http://localhost:3000
npm run dev -- -H 0.0.0.0    # reachable from your phone on the same WiFi
npm test                     # 227 unit tests
npm run build
```

One extra step for the AI features:

```bash
cp .env.example .env.local   # then fill in OPENAI_API_KEY
```

`.env.local` is gitignored, and the key is read only by the server route — it **never reaches the browser bundle**. Switching models is a one-line change to `AI_MODEL`; `AI_BASE_URL` points at any OpenAI-compatible service. Without a key the app runs as normal and only those two buttons report that nothing is configured.

For deployment see [DEPLOY.md](./DEPLOY.md).

---

## Privacy

Records live in the browser (IndexedDB). There are no accounts, and the entire backend is the single `/api/ai` route, which exists only to hold the API key for you. **Apart from the moment you press an AI button, nothing leaves your device.**

- Recording, browsing, exporting, reviewing: fully offline, not one request
- Pressing "Analyze" or "Draft my speech": sends a snapshot of **this one game** (including your role, vision and guesses) to the model provider. You're asked the first time, and the exact payload stays inspectable on the result page
- Records from your other games are never included

The trade-off is that browsers may clear data for sites you haven't opened in a while — so **add the page to your home screen** (an installed PWA is exempt) and export a JSON backup after a session.

If accounts and cloud sync ever land, data will leave the device, and the signup flow will spell out exactly what syncs.
