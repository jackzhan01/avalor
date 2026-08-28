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
  announced: { type: "string", enum: ["good", "evil"] },
  target: SEAT,
  memoryPatch: MEMORY_PATCH_OR_NULL,
  rationale: { type: ["string", "null"], maxLength: 300 },
};

export function fragmentFor(field: SchemaField): Fragment {
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
