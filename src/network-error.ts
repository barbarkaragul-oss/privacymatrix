/** Preserve useful connection diagnostics without exposing request headers or credentials. */
export function networkError(error: unknown, timeoutMs?: number): string {
  if (!(error instanceof Error)) return 'request failed';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return `timeout${timeoutMs ? ` after ${timeoutMs}ms` : ''}`;
  const cause = error.cause as { code?: unknown } | undefined;
  const code = typeof cause?.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : '';
  // Only an untrusted chain can be fixed by trusting the system's roots; an expired certificate or a
  // name mismatch is the site's problem, and is reported as it is.
  if (/^(UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(code)) {
    return `TLS certificate verification failed (${code}); use Node 22.19+ with NODE_USE_SYSTEM_CA=1 for trusted system certificates`;
  }
  if (/CERT/.test(code)) return `TLS certificate verification failed (${code})`;
  return code ? `${error.message} (${code})` : error.message;
}
