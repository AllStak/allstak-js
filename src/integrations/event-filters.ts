import { defineIntegration } from '../integration';
import type { AllStakConfig } from '../client';
import type { ErrorIngestPayload, EventFilterPattern } from '../modules/errors';

const DEFAULT_IGNORE_ERRORS: EventFilterPattern[] = [
  /^Script error\.?$/i,
  /^Javascript error: Script error\.? on line 0$/i,
  /^ResizeObserver loop completed with undelivered notifications\.?$/i,
  /^ResizeObserver loop limit exceeded$/i,
  /^Non-Error promise rejection captured with value: null$/i,
  /^Non-Error promise rejection captured with value: undefined$/i,
];

export const eventFiltersIntegration = defineIntegration(() => ({
  name: 'EventFilters',
  processEvent(event, client) {
    const options = client.getOptions();
    return shouldDropEvent(event, options) ? null : event;
  },
}));

export const inboundFiltersIntegration = eventFiltersIntegration;

function shouldDropEvent(payload: ErrorIngestPayload, config: AllStakConfig): boolean {
  const ignoreErrors = [
    ...((config as any).disableDefaultIgnoreErrors ? [] : DEFAULT_IGNORE_ERRORS),
    ...(((config as any).ignoreErrors ?? []) as EventFilterPattern[]),
  ];
  if (matchesAny(possibleMessages(payload), ignoreErrors)) return true;

  const url = eventFilterUrl(payload);
  const denyUrls = (((config as any).denyUrls ?? []) as EventFilterPattern[]);
  if (url && matchesPattern(url, denyUrls)) return true;

  const allowUrls = (((config as any).allowUrls ?? []) as EventFilterPattern[]);
  if (allowUrls.length > 0 && url && !matchesPattern(url, allowUrls)) return true;

  return false;
}

function possibleMessages(payload: ErrorIngestPayload): string[] {
  return [
    payload.message,
    `${payload.exceptionClass}: ${payload.message}`,
    payload.exceptionClass,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function matchesAny(values: string[], patterns: EventFilterPattern[]): boolean {
  return values.some((value) => matchesPattern(value, patterns));
}

function matchesPattern(value: string, patterns: EventFilterPattern[]): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === 'string') return value.includes(pattern);
    return pattern.test(value);
  });
}

function eventFilterUrl(payload: ErrorIngestPayload): string | undefined {
  const frames = payload.frames;
  if (frames?.length) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      const candidate = frame.filename || frame.absPath;
      if (candidate && candidate !== '<anonymous>' && candidate !== '[native code]') {
        return candidate;
      }
    }
  }
  return payload.requestContext?.path || payload.requestContext?.host;
}
