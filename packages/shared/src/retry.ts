/** Full-jitter exponential backoff (AWS architecture blog style): random in [0, min(cap, base * 2^attempt)]. */
export function backoffMs(attempt: number, baseMs = 20, capMs = 1000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Integer seconds for Retry-After, jittered so a fleet of clients does not retry in lock-step. */
export function jitteredRetryAfterSeconds(baseSeconds: number, spreadSeconds: number): number {
  return Math.max(1, Math.round(baseSeconds + Math.random() * spreadSeconds));
}
