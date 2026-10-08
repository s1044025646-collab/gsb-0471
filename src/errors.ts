export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_DECIMAL"
  | "OUT_OF_RANGE"
  | "TOO_MANY_DECIMALS"
  | "SCIENTIFIC_NOTATION_NOT_ALLOWED"
  | "EMPTY_ID"
  | "DUPLICATE_ID"
  | "EMPTY_FAMILY"
  | "TOO_MANY_TESTS"
  | "MISSING_FIELD"
  | "FAMILY_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "IMPORT_REJECTED"
  | "BAD_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL";

export class BhError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BhError";
    this.code = code;
    this.details = details;
  }
}
