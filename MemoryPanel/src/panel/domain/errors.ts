/** Domain errors. The HTTP layer maps them to status codes. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND', 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(msg = 'forbidden') {
    super(msg, 'FORBIDDEN', 403);
  }
}

export class ConflictError extends DomainError {
  constructor(msg: string) {
    super(msg, 'CONFLICT', 409);
  }
}

/**
 * Unified mapping of Core upstream errors. skill-client translates core business codes (40001/40301/40401/...)
 * into local DomainError subclasses so service / route need not check codes again.
 */
export class CoreUpstreamError extends DomainError {
  constructor(
    code: string,
    httpStatus: number,
    message: string,
    /** Original core business code, for troubleshooting; not returned directly to the frontend. */
    readonly upstreamCode?: number,
  ) {
    super(message, code, httpStatus);
    this.name = 'CoreUpstreamError';
  }
}
