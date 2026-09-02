/**
 * The strict JSON Schema that goes on the wire with every request.
 *
 * The prompt already spells the shape out in Chinese; this is the same shape
 * again, in the form a provider can enforce. Both exist on purpose: strict
 * structured output stops most malformed answers at the provider, and the
 * Chinese description is what makes the model produce something SENSIBLE
 * inside that shape rather than merely well-typed.
 *
 * STRICT MODE HAS TWO RULES that shape everything below: every property must
 * be listed in `required`, and `additionalProperties` must be false. So an
 * "optional" field is expressed as a required field that may be null, and the
 * validator in `structured.ts` treats null and absent identically.
 *
 * Fragments are keyed by FIELD NAME rather than embedded in `tasks.ts`, and
 * `json-schema.test.ts` asserts every field of every task has one. That makes
 * the coupling a test failure instead of a silently unenforced field.
 */

import { GOOD_ROLES, EVIL_ROLES } from "@/lib/types/game";
import type { SchemaField, TaskSchema } from "../prompts/tasks";
import { COGNITION_LIMITS_V3 } from "../cognition/limits";
import { voteAnalysisFragment } from "../cognition/vote-discipline";
import { assassinationFragment } from "../cognition/assassination";
import { CLAIM_PURPOSES } from "../cognition/claim-persistence";

export type Fragment = Readonly<Record<string, unknown>>;

const SEAT: Fragment = { type: "integer", minimum: 1, maximum: 10 };

const SEAT_ARRAY_OR_NULL: Fragment = {
  type: ["array", "null"],
  items: SEAT,
  minItems: 0,
  maxItems: 10,
};

const STANCES_OR_NULL: Fragment = {
  type: ["array", "null"],
  maxItems: 9,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["seat", "valence", "confidence"],
    properties: {
      seat: SEAT,
      valence: { type: "number", minimum: -1, maximum: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

const MEMORY_PATCH_OR_NULL: Fragment = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["beliefs", "intentions", "commitments"],
  properties: {
    beliefs: {
      type: ["array", "null"],
      maxItems: 9,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seat", "pEvil", "note"],
        properties: {
          seat: SEAT,
          pEvil: { type: "number", minimum: 0, maximum: 1 },
          note: { type: "string", maxLength: 120 },
        },
      },
    },
    intentions: { type: ["array", "null"], maxItems: 3, items: { type: "string" } },
    commitments: { type: ["array", "null"], maxItems: 5, items: { type: "string" } },
  },
};

const ROLE_OR_NULL: Fragment = {
  type: ["string", "null"],
  enum: [...GOOD_ROLES, ...EVIL_ROLES, null],
};

/**
 * One fragment per field name. Names are reused across tasks with the same
 * meaning, which is what makes a single table correct rather than a shortcut.
 */
const FRAGMENTS: Readonly<Record<string, Fragment>> = {
  ladySide: { type: "string", enum: ["left", "right"] },
  publicMessage: { type: "string" },
  message: { type: "string" },
  team: { type: "array", items: SEAT, minItems: 2, maxItems: 5 },
  tentativeTeam: SEAT_ARRAY_OR_NULL,
  noTeamYet: { type: ["boolean", "null"] },
  stances: STANCES_OR_NULL,
  claim: ROLE_OR_NULL,
  retractClaim: { type: ["boolean", "null"] },
  choice: { type: "string", enum: ["approve", "reject"] },
  card: { type: "string", enum: ["success", "fail"] },
  /**
   * The `prompt-0.6.0` mission-card coordination record.
   *
   * BOUNDED CONCLUSIONS ONLY — a designation, a count, a card, an intent, and
   * public evidence ids. Deliberately no free-form field: the point is a record
   * a reviewer can group by, not a place to narrate.
   */
  /** `prompt-0.6.0`: the Assassin's bounded candidate ranking. */
  assassination: assassinationFragment(COGNITION_LIMITS_V3),
  /** `prompt-0.6.0`: the six-question vote analysis. See `vote-discipline.ts`. */
  voteAnalysis: voteAnalysisFragment(COGNITION_LIMITS_V3),
  coordination: {
    type: "object",
    additionalProperties: false,
    required: ["designated", "failsRequired", "card", "intent", "evidenceIds"],
    properties: {
      designated: { type: "boolean" },
      failsRequired: { type: "integer", minimum: 1, maximum: 2 },
      card: { type: "string", enum: ["success", "fail"] },
      intent: { type: "string", enum: ["sabotage", "conceal"] },
      evidenceIds: { type: "array", items: { type: "string" }, maxItems: 4 },
    },
  },
  announced: { type: "string", enum: ["good", "evil"] },
  /** `prompt-0.7.0`: why this claim is being made now. See `claim-persistence`. */
  claimPurpose: {
    type: ["string", "null"],
    enum: [...CLAIM_PURPOSES, null],
  },
  /**
   * `prompt-0.7.0`: which public events made a standing claim ambiguous.
   *
   * PRIVATE. It sits in the planner's answer, never in a public field, and the
   * spokesperson's schema has no slot it could reach.
   */
  ambiguityEventIds: {
    type: ["array", "null"],
    items: { type: "integer", minimum: 0 },
    maxItems: 4,
  },
  target: SEAT,
  memoryPatch: MEMORY_PATCH_OR_NULL,
  rationale: { type: ["string", "null"], maxLength: 300 },
};

export function fragmentFor(field: SchemaField): Fragment {
  // An explicit override wins. Used where the shape differs BY VERSION under
  // one field name — see `SchemaField.fragment`.
  if (field.fragment) return field.fragment;
  const fragment = FRAGMENTS[field.name];
  if (!fragment) {
    throw new Error(
      `no JSON Schema fragment for field "${field.name}" — add one to model/json-schema.ts`,
    );
  }
  return fragment;
}

/** The strict schema for one task. */
export function jsonSchemaFor(task: TaskSchema): Fragment {
  const properties: Record<string, Fragment> = {};
  for (const field of task.fields) properties[field.name] = fragmentFor(field);
  return {
    type: "object",
    additionalProperties: false,
    // Strict mode requires every property listed. Optionality is expressed by
    // the fragment allowing null, not by omission from this list.
    required: task.fields.map((f) => f.name),
    properties,
  };
}

/** A schema name the provider will accept: letters, digits and underscores. */
export function schemaNameFor(task: TaskSchema): string {
  return `avalon_${task.id.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}
