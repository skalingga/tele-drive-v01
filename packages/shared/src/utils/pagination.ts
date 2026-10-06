/**
 * Opaque keyset cursor: the sort-key value of the last returned row plus its id
 * as a tie-breaker. Stable under concurrent inserts/deletes (no offsets).
 */
export interface CursorPayload {
  /** Sort key of the last row (string for names/dates, number for sizes). */
  v: string | number;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "id" in parsed &&
      "v" in parsed &&
      typeof parsed.id === "string" &&
      (typeof parsed.v === "string" || typeof parsed.v === "number")
    ) {
      return { v: parsed.v, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}
