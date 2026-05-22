# AllStak React + Vite example

Minimal React app showing how to initialize `@allstak/js/browser` and use the React error boundary helper from `@allstak/js/react`.

## Run

```bash
npm install
npm run dev
```

Set these values before building or running the app:

```bash
VITE_ALLSTAK_API_KEY=ask_live_xxx
VITE_ALLSTAK_RELEASE=react-example@1.0.0
```

## What to look at

- `src/main.tsx` initializes the SDK.
- The React error boundary captures component errors.
- The Vite config can upload source maps when `ALLSTAK_UPLOAD_TOKEN` is set.
