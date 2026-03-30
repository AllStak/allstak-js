/**
 * AllStak SDK singleton for the React example app.
 * Import from here to get a pre-initialized SDK instance.
 */
import { AllStak } from '../../../dist/browser/index.mjs';

AllStak.init({
  dsn: 'http://ask_9c3775eab9264e9aa4048b7bafc1c512@localhost:8080',
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
