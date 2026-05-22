import { defineIntegration } from '../integration';
import type { ErrorIngestPayload } from '../modules/errors';

export const dedupeIntegration = defineIntegration(() => {
  let previousEventSignature: string | null = null;

  return {
    name: 'Dedupe',
    processEvent(event, client) {
      if (client.getOptions().dedupe === false) return event;

      const signature = eventSignature(event);
      if (!signature) return event;
      if (signature === previousEventSignature) return null;
      previousEventSignature = signature;
      return event;
    },
  };
});

function eventSignature(payload: ErrorIngestPayload): string | null {
  const frameKey = (payload.frames ?? [])
    .map((frame) => [
      frame.filename ?? '',
      frame.function ?? '',
      frame.lineno ?? '',
      frame.colno ?? '',
    ].join(':'))
    .join('|');
  const fingerprint = payload.fingerprint?.join('\u0000') ?? '';
  const base = [
    payload.exceptionClass,
    payload.message,
    fingerprint,
    frameKey,
  ].join('\u0001');
  return base.trim().length > 0 ? base : null;
}
