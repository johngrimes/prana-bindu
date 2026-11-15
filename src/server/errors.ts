import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { BlobNotFoundError } from "../storage/errors.js";

/** `{error: {code, message, details?}}` (docs/spec.md §9). */
export function errorResponse(c: Context, status: ContentfulStatusCode, code: string, message: string, details?: unknown): Response {
  return c.json({ error: details === undefined ? { code, message } : { code, message, details } }, status);
}

/** Errors carrying an API code and HTTP status: AuthError, DomainError, ImportError. */
interface CodedError {
  code: string;
  status: number;
  message: string;
  details?: unknown;
}

const isCodedError = (err: unknown): err is CodedError => {
  const e = err as Partial<CodedError>;
  return err instanceof Error && typeof e.code === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 600;
};

/** Maps thrown errors to the JSON error envelope; unknown errors become an opaque 500. */
export const handleError: ErrorHandler = (err, c) => {
  if (isCodedError(err)) {
    return errorResponse(c, err.status as ContentfulStatusCode, err.code, err.message, err.details);
  }
  if (err instanceof BlobNotFoundError) return errorResponse(c, 404, "not_found", "Attachment content not found");
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const code = status === 413 ? "payload_too_large" : status === 400 ? "bad_request" : `http_${status}`;
    return errorResponse(c, status, code, err.message || "Request failed");
  }
  console.error(`[prana-bindu] ${c.req.method} ${c.req.path} failed:`, err);
  return errorResponse(c, 500, "internal_error", "Internal server error");
};

/** `defaultHook` for OpenAPIHono: zod validation failures → 400 `validation_error`. */
export const validationHook = (
  result: { success: true } | { success: false; error: { issues: unknown[] } },
  c: Context,
): Response | undefined => {
  if (!result.success) return errorResponse(c, 400, "validation_error", "Request validation failed", result.error.issues);
  return undefined;
};
