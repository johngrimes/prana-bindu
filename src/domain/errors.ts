export type DomainErrorCode =
  | "validation_error"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "parse_error"
  | "invalid_operation";

const STATUS: Record<DomainErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  parse_error: 422,
  invalid_operation: 422,
};

/** Business-rule failure; `status` is the HTTP status the API maps it to. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const notFound = (kind: string, id: string): DomainError =>
  new DomainError("not_found", `${kind} not found: ${id}`, { kind, id });
