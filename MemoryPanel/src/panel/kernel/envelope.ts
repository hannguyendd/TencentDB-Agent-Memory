/** Kernel HTTP response envelope (consistent with /v3/meta/*). */

export interface MetaEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

/** envelope.code -> HTTP status (§4.8.2): 0 -> 200; 400-599 -> code; otherwise -> 502. */
export function mapHttpStatusFromEnvelopeCode(code: number): number {
  if (code >= 400 && code < 600) return code;
  if (code === 0) return 200;
  return 502;
}
