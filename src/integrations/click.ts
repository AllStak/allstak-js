import { defineIntegration } from '../integration';
import { instrumentClicks } from '../modules/auto-breadcrumbs';

export const clickIntegration = defineIntegration(() => ({
  name: 'ClickBreadcrumbs',
  setup(client) {
    const options = client.getOptions();
    if (options.autoBreadcrumbs === false || options.autoBreadcrumbsClick === false) return;

    instrumentClicks(
      (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
      {
        beforeBreadcrumb: options.beforeBreadcrumb,
        maxSelectorLength: options.clickBreadcrumbMaxSelectorLength,
      },
    );
  },
}));
