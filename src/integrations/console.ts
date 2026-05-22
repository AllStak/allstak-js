import { defineIntegration } from '../integration';
import { instrumentConsole } from '../modules/auto-breadcrumbs';

export const consoleIntegration = defineIntegration(() => ({
  name: 'Console',
  setup(client) {
    if (client.getOptions().autoBreadcrumbs === false) return;

    instrumentConsole((type, msg, level, data) => client.addBreadcrumb(type, msg, level, data));

    client.onLogBreadcrumb((level, message) => {
      const breadcrumbLevel = level === 'warn' ? 'warn' : 'error';
      client.addBreadcrumb('log', message, breadcrumbLevel, { logLevel: level });
    });
  },
}));
