import type { AllStakClient } from './client';
import type { ErrorIngestPayload } from './modules/errors';
import type { SpanData } from './modules/tracing';

export interface AllStakIntegration {
  name: string;
  setupOnce?: () => void;
  setup?: (client: AllStakClient) => void;
  processEvent?: (
    event: ErrorIngestPayload,
    client: AllStakClient,
  ) => ErrorIngestPayload | null | undefined | Promise<ErrorIngestPayload | null | undefined>;
  processSpan?: (
    span: SpanData,
    client: AllStakClient,
  ) => SpanData | null | undefined;
  isDefaultInstance?: boolean;
}

export type IntegrationIndex = Record<string, AllStakIntegration>;
export type IntegrationFactory<Args extends unknown[] = unknown[]> = (...args: Args) => AllStakIntegration;
export type IntegrationOption =
  | AllStakIntegration[]
  | ((defaultIntegrations: AllStakIntegration[]) => AllStakIntegration | AllStakIntegration[]);

const installedOnce = new Set<string>();

export function defineIntegration<Fn extends IntegrationFactory>(factory: Fn): Fn {
  return factory;
}

export function getIntegrationsToSetup(options: {
  defaultIntegrations?: boolean | AllStakIntegration[];
  integrations?: IntegrationOption;
}): AllStakIntegration[] {
  const defaults = resolveDefaultIntegrations(options.defaultIntegrations);
  for (const integration of defaults) {
    integration.isDefaultInstance = true;
  }

  const user = options.integrations;
  if (Array.isArray(user)) {
    return filterDuplicateIntegrations([...defaults, ...user]);
  }
  if (typeof user === 'function') {
    const resolved = user(defaults);
    return filterDuplicateIntegrations(Array.isArray(resolved) ? resolved : [resolved]);
  }
  return filterDuplicateIntegrations(defaults);
}

export function setupIntegrations(
  client: AllStakClient,
  integrations: AllStakIntegration[],
): IntegrationIndex {
  const index: IntegrationIndex = {};

  for (const integration of integrations) {
    if (index[integration.name]) continue;
    index[integration.name] = integration;

    if (integration.setupOnce && !installedOnce.has(integration.name)) {
      integration.setupOnce();
      installedOnce.add(integration.name);
    }

    integration.setup?.(client);

    if (integration.processEvent) {
      client.addEventProcessor((event) => integration.processEvent!(event, client));
    }
    if (integration.processSpan) {
      client.addSpanProcessor((span) => integration.processSpan!(span, client));
    }
  }

  return index;
}

function resolveDefaultIntegrations(
  value: boolean | AllStakIntegration[] | undefined,
): AllStakIntegration[] {
  if (value === false) return [];
  if (Array.isArray(value)) return [...value];
  return [];
}

function filterDuplicateIntegrations(integrations: AllStakIntegration[]): AllStakIntegration[] {
  const byName: Record<string, AllStakIntegration> = {};
  for (const integration of integrations) {
    const existing = byName[integration.name];
    if (existing && !existing.isDefaultInstance && integration.isDefaultInstance) {
      continue;
    }
    byName[integration.name] = integration;
  }
  return Object.values(byName);
}
