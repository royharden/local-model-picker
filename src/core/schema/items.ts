// Item bank (data/items.v1.json), speed prompt set (data/prompts.v1.json) and grader fixture files
// (fixtures/graders/{dev,heldout}.v1.json). Provenance rule D18: dataset ids only for rows that
// were actually fetched; otherwise a labelled placeholder and the bank declares complete: false.
import { z } from "zod";
import { idString, isoUtc } from "./common.js";

export const ITEM_KINDS = ["numeric", "choice", "instruction", "extraction"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_SOURCES = ["gsm8k", "mmlu", "original", "placeholder"] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

const itemId = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/, "item ids are lowercase letters, digits, . _ -");
const promptText = z.string().min(1).max(8000);

/** Where a fetched dataset row came from (D18). */
export const ProvenanceSchema = z
  .object({
    url: z.string().min(1).max(500),
    revision: z.string().min(1).max(100), // a commit sha, or "unpinned main"
    fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fetch date YYYY-MM-DD"),
    rowIndex: z.number().int().nonnegative(),
  })
  .strict();

export type Provenance = z.infer<typeof ProvenanceSchema>;

const itemCommon = {
  id: itemId,
  source: z.enum(ITEM_SOURCES),
  sourceId: z.string().min(1).max(200).nullable(),
  sourceRevision: z.string().min(1).max(100).nullable(),
  provenance: ProvenanceSchema.nullable(),
  licence: z.string().min(1).max(50),
  prompt: promptText,
};

/** IFEval-style verifiable instruction rules (originals, MIT; IFEval credited as methodology inspiration). */
export const InstructionRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("max_words"), max: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("min_words"), min: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("include_keywords"), keywords: z.array(z.string().min(1).max(50)).min(1).max(10) }).strict(),
  z.object({ type: z.literal("exclude_keywords"), keywords: z.array(z.string().min(1).max(50)).min(1).max(10) }).strict(),
  z.object({ type: z.literal("all_lowercase") }).strict(),
  z.object({ type: z.literal("all_uppercase") }).strict(),
  z.object({ type: z.literal("bullet_count"), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("starts_with"), text: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal("ends_with"), text: z.string().min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal("json_keys"),
      keys: z.array(z.string().min(1).max(50)).min(1).max(20),
      // strict: whole response (after one optional code fence) must parse; non-strict: first balanced object.
      strict: z.boolean(),
    })
    .strict(),
]);

export type InstructionRule = z.infer<typeof InstructionRuleSchema>;

export const ItemSchema = z.discriminatedUnion("kind", [
  z.object({ ...itemCommon, kind: z.literal("numeric"), answer: z.string().min(1).max(50) }).strict(),
  z
    .object({
      ...itemCommon,
      kind: z.literal("choice"),
      choices: z.array(z.string().min(1).max(1000)).length(4),
      answer: z.enum(["A", "B", "C", "D"]),
    })
    .strict(),
  z.object({ ...itemCommon, kind: z.literal("instruction"), rule: InstructionRuleSchema }).strict(),
  z
    .object({
      ...itemCommon,
      kind: z.literal("extraction"),
      format: z.enum(["text", "json"]),
      // text: one exact normalised string; json: expected key -> normalised string value.
      answer: z.union([z.string().min(1).max(500), z.record(z.string().min(1).max(50), z.string().max(500))]),
      strict: z.boolean().nullable(),
    })
    .strict(),
]);

export type Item = z.infer<typeof ItemSchema>;

function itemIssues(item: Item): string[] {
  const out: string[] = [];
  const dataset = item.source === "gsm8k" || item.source === "mmlu";
  if (dataset && (item.sourceId === null || item.provenance === null)) {
    out.push("a dataset item carries sourceId and provenance (only rows actually fetched)");
  }
  if (!dataset && (item.sourceId !== null || item.provenance !== null || item.sourceRevision !== null)) {
    out.push("original and placeholder items carry no dataset id, revision or provenance");
  }
  if (item.kind === "extraction") {
    if (item.format === "json" && (typeof item.answer === "string" || item.strict === null)) {
      out.push("a json extraction item has an object answer and strict true|false");
    }
    if (item.format === "text" && (typeof item.answer !== "string" || item.strict !== null)) {
      out.push("a text extraction item has a string answer and strict null");
    }
  }
  return out;
}

export const ItemBankSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1).max(50),
    complete: z.boolean(),
    items: z.array(ItemSchema).min(1).max(200),
  })
  .strict()
  .superRefine((bank, ctx) => {
    const seen = new Set<string>();
    bank.items.forEach((item, i) => {
      if (seen.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i, "id"], message: `duplicate item id ${item.id}` });
      seen.add(item.id);
      for (const message of itemIssues(item)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i], message });
    });
    if (bank.complete && bank.items.some((it) => it.source === "placeholder")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["complete"], message: "a bank containing placeholder items declares complete: false" });
    }
  });

export type ItemBank = z.infer<typeof ItemBankSchema>;

/** Speed prompt set: exactly 3 fixed prompts (long generation, ~1,500-token prompt, mixed chat). */
export const SpeedPromptSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    messages: z
      .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(20000) }).strict())
      .min(1)
      .max(10),
  })
  .strict();

export const PromptSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1).max(50),
    prompts: z.array(SpeedPromptSchema).length(3),
  })
  .strict()
  .superRefine((set, ctx) => {
    if (new Set(set.prompts.map((p) => p.id)).size !== set.prompts.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompts"], message: "prompt ids are unique" });
    }
  });

export type SpeedPrompt = z.infer<typeof SpeedPromptSchema>;
export type PromptSet = z.infer<typeof PromptSetSchema>;

/** One synthetic grader response with human-set expectations written before grader code. */
export const GraderCaseSchema = z
  .object({
    id: idString,
    itemId: itemId,
    response: z.string().max(30000),
    expectedExtracted: z.string().max(1000).nullable(),
    expectedCorrect: z.boolean(),
    traps: z.array(z.string().min(1).max(100)).max(20),
    note: z.string().max(500).nullable(),
  })
  .strict();

export const GraderFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    split: z.enum(["dev", "heldout"]),
    seed: z.number().int(),
    frozenAt: isoUtc,
    synthetic: z.literal(true),
    cases: z.array(GraderCaseSchema).min(1).max(200),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (new Set(f.cases.map((c) => c.id)).size !== f.cases.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "grader case ids are unique" });
    }
  });

export type GraderCase = z.infer<typeof GraderCaseSchema>;
export type GraderFixture = z.infer<typeof GraderFixtureSchema>;
