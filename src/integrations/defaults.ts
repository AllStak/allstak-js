import type { AllStakIntegration } from '../integration';
import { consoleIntegration } from './console';
import { databaseIntegration } from './database';
import { dedupeIntegration } from './dedupe';
import { eventFiltersIntegration } from './event-filters';
import { httpClientIntegration } from './http-client';

export function getDefaultIntegrations(): AllStakIntegration[] {
  return [
    eventFiltersIntegration(),
    dedupeIntegration(),
    consoleIntegration(),
    httpClientIntegration(),
    databaseIntegration(),
  ];
}
