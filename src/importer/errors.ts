export type ImportErrorCode =
  | "invalid_format"
  | "encrypted"
  | "unsupported_version"
  | "not_found"
  | "network"
  | "corrupt";

const STATUS: Record<ImportErrorCode, number> = {
  invalid_format: 422,
  encrypted: 422,
  unsupported_version: 422,
  not_found: 404,
  network: 502,
  corrupt: 422,
};

/** A user-readable import failure. Nothing has been written to the database when this is thrown. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  /** Suggested HTTP status for API responses. */
  readonly status: number;

  constructor(code: ImportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImportError";
    this.code = code;
    this.status = STATUS[code];
  }
}
