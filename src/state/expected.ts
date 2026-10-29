import bankJson from "../../data/items.v1.json";
import { ItemBankSchema } from "../core/index.js";
import type { RunFile } from "../core/index.js";

// SHA256 of recursively key-sorted compact UTF-8 JSON, identical to the CLI canonical contract.
// Computed by source-only data transformation; this constant must change when the bank changes.
export const BUNDLED_ITEM_SET_HASH = "ed6a79a0616c794b8b3f8e7825e6845d2be41818ab29f7abae9fa00eb30fc1b7";
const bank = ItemBankSchema.parse(bankJson);
export function expectedFor(run: RunFile, itemId: string): string {
  if (run.itemSetHash !== BUNDLED_ITEM_SET_HASH) return "Unavailable: this run's item-bank contract is not bundled. No expected answer is inferred.";
  const item = bank.items.find((entry) => entry.id === itemId);
  if (!item) return "Unavailable: item is absent from the verified bundled bank.";
  return item.kind === "instruction" ? JSON.stringify(item.rule, null, 2) : typeof item.answer === "string" ? item.answer : JSON.stringify(item.answer, null, 2);
}
