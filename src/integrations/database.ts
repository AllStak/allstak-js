import { defineIntegration } from '../integration';
import { enableDbAutoInstrumentation } from '../modules/database';

export const databaseIntegration = defineIntegration(() => ({
  name: 'Database',
  setup(client) {
    const options = client.getOptions();
    if (options.autoDbInstrumentation === false) return;
    if (!client.isNodeRuntime()) return;

    enableDbAutoInstrumentation(client.database, {
      service: options.tags?.service,
      environment: options.environment,
    });
  },
}));
