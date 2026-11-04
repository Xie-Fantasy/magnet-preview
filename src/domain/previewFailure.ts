export type PreviewFailureCategory =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'not_found'
  | 'invalid_response'
  | 'authorization'
  | 'circuit_open';

export class PreviewFailure extends Error {
  constructor(
    readonly category: PreviewFailureCategory,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(category);
    this.name = 'PreviewFailure';
  }
}
