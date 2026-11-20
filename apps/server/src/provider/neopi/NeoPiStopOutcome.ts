import type {
  NeoPiNativeObservedJournalEntry,
  NeoPiNativeObservedMessage,
  NeoPiStopOutcome,
} from "@t3tools/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Builds the typed stop outcome from the whitelist and drops everything else,
 * at every boundary where a native message enters NeoCode (r12 §P "Corrections
 * in r8": "in NeoCode at decode from R1, which builds the typed outcome from the
 * whitelisted fields and drops everything else. The two private fields, the
 * handle, the frozen request and the raw object are never carried, stored or
 * shown."). Each kept value is exactly as the source gave it (§P client
 * contract); a value of another type is dropped, never coerced.
 */
export function observeNeoPiMessage(raw: Record<string, unknown>): {
  readonly message: NeoPiNativeObservedMessage;
  readonly stopOutcome: NeoPiStopOutcome | undefined;
} {
  // The raw `stopDetails` carries `fallback_credit_token` and
  // `fallback_has_prefill_claim`; `fallbackCreditHandle` holds the token again
  // and the frozen request. Neither leaves decode.
  const { stopDetails: _stopDetails, fallbackCreditHandle: _handle, ...kept } = raw;
  const details = asRecord(raw.stopDetails);
  const outcome: {
    stopType?: string;
    category?: string | null;
    explanation?: string | null;
    errorClassificationMessage?: string;
    errorStatus?: number;
    errorId?: number;
  } = {};
  if (typeof details?.type === "string") outcome.stopType = details.type;
  if (typeof details?.category === "string" || details?.category === null)
    outcome.category = details.category;
  if (typeof details?.explanation === "string" || details?.explanation === null)
    outcome.explanation = details.explanation;
  if (typeof raw.errorClassificationMessage === "string")
    outcome.errorClassificationMessage = raw.errorClassificationMessage;
  if (typeof raw.errorStatus === "number") outcome.errorStatus = raw.errorStatus;
  if (typeof raw.errorId === "number") outcome.errorId = raw.errorId;
  return {
    // `kept` has no `stopDetails` key by construction, which is all the contract adds.
    message: kept as NeoPiNativeObservedMessage,
    stopOutcome: Object.keys(outcome).length > 0 ? outcome : undefined,
  };
}

/** A native journal entry through the same filter; undefined when it lacks the entry identity fields. */
export function observeNeoPiJournalEntry(
  raw: unknown,
): NeoPiNativeObservedJournalEntry | undefined {
  const entry = asRecord(raw);
  if (
    !entry ||
    typeof entry.id !== "string" ||
    typeof entry.type !== "string" ||
    typeof entry.timestamp !== "string" ||
    (typeof entry.parentId !== "string" && entry.parentId !== null)
  )
    return undefined;
  // A native `stopOutcome` key is not ours to trust; only decode builds one. A
  // `message` that is not a record has no shape the contract can carry.
  const { id, parentId, type, timestamp, message: native, stopOutcome: _native, ...rest } = entry;
  const head = { ...rest, id, parentId, type, timestamp };
  const record = asRecord(native);
  if (!record) return head;
  const { message, stopOutcome } = observeNeoPiMessage(record);
  return stopOutcome === undefined ? { ...head, message } : { ...head, message, stopOutcome };
}
