/** Audit entries: machine-readable correlation between held input and its re-send. */
import { createHash } from "node:crypto";

/**
 * Written via pi.appendEntry as session-file `custom` entries: they never enter the model context, and
 * the note builder / recall ignore them (entryItems in entries.ts only surfaces "subagents:record").
 * One entry type, "context-relay:resend", written right before held input is re-sent as the next user
 * message. Each held item is fingerprinted (sha256 of its text), so the user entry that follows can be
 * matched to the input an earlier handler held with { action: "handled" } — whose re-sent run otherwise
 * carries no link back to the prompt that was held (an RPC prompt answered "handled" starts no run at
 * all, so an RPC client tracking jobs by that answer sees the real work start with no provenance).
 *
 * The relay itself needs no second record: it is already in the session file as the compaction entry
 * (details.relay=true, notePath) and in context-relay/log.jsonl. A duplicate record would also break
 * the invariant the E2E suite pins — one relay adds exactly one entry.
 */
export const RESEND_ENTRY_TYPE = "context-relay:resend";

export interface HeldItemShape {
  text: string;
  images?: readonly unknown[];
}

export interface HeldItemFingerprint {
  sha256: string;
  chars: number;
  images: number;
}

export function fingerprintHeldItem(item: HeldItemShape): HeldItemFingerprint {
  return {
    sha256: createHash("sha256").update(item.text, "utf8").digest("hex"),
    chars: item.text.length,
    images: item.images?.length ?? 0,
  };
}

export interface ResendAuditInput {
  at: string;
  trigger: string;
  items: readonly HeldItemShape[];
}

export function buildResendRecord(input: ResendAuditInput): Record<string, unknown> {
  const items = input.items.map(fingerprintHeldItem);
  return { v: 1, at: input.at, trigger: input.trigger, items, totalChars: items.reduce((n, i) => n + i.chars, 0) };
}
