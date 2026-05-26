/**
 * AllStak SDK singleton for the React example app.
 * Import from here to get a pre-initialized SDK instance.
 */
import { AllStak } from '../../../dist/browser/index.mjs';

AllStak.init({
  dsn: import.meta.env.VITE_ALLSTAK_DSN || 'http://ask_live_xxx@localhost:8080',
  environment: 'react-example',
  release: '1.0.0',
  tags: {
    service: 'allstak-react-demo',
    framework: 'react-vite',
  },
  sessionReplay: {
    enabled: true,
    maskAllInputs: true,
    sampleRate: 1.0,
  },
});

AllStak.setUser({ id: 'react-user-1', email: 'react@allstak.io' });

export { AllStak };
