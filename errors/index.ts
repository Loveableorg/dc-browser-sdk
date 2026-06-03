// Typed errors used by the shared diagram core so MCP/REST/SDK adapters
// can map them to native shapes (JSON-RPC error codes, HTTP statuses, etc.).
//
// Pure TS, no runtime deps. Universal — runs in browser + Deno.

export class DomainError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, details);
    this.name = "NotFoundError";
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("permission_denied", message, details);
    this.name = "PermissionDeniedError";
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_error", message, details);
    this.name = "ValidationError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("conflict", message, details);
    this.name = "ConflictError";
  }
}
