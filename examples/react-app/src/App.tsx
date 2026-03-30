import { useState, useEffect, useCallback } from 'react';
import { AllStak } from './allstak';
import './App.css';

interface LogEntry {
  id: number;
  time: string;
  level: string;
  action: string;
  detail: string;
}

let logId = 0;

function useActivityLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const addLog = useCallback((level: string, action: string, detail: string) => {
    const now = new Date().toLocaleTimeString('en', { hour12: false });
    setLogs((prev) => [...prev.slice(-99), { id: ++logId, time: now, level, action, detail }]);
  }, []);
  const clearLogs = useCallback(() => setLogs([]), []);
  return { logs, addLog, clearLogs };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      {children}
    </div>
  );
}

function Btn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button style={{ ...styles.btn, background: color }} onClick={onClick}>
      {label}
    </button>
  );
}

export default function App() {
  const { logs, addLog, clearLogs } = useActivityLog();
  const [sessionId] = useState(() => AllStak.getSessionId());
  const [logMsg, setLogMsg] = useState('User clicked buy button');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [httpPath, setHttpPath] = useState('/api/products');
  const [httpStatus, setHttpStatus] = useState(200);
  const [httpDuration, setHttpDuration] = useState(120);
  const [cronSlug, setCronSlug] = useState('react-data-sync');
  const [cronDuration, setCronDuration] = useState(2200);
  const [cronMessage, setCronMessage] = useState('');
  const [userId, setUserId] = useState('react-user-42');
  const [userEmail, setUserEmail] = useState('customer@shop.com');
  const [tagKey, setTagKey] = useState('plan');
  const [tagVal, setTagVal] = useState('pro');
  const [masked, setMasked] = useState('');

  useEffect(() => {
    AllStak.log.info('React app mounted', {
      sessionId,
      environment: 'react-example',
      timestamp: new Date().toISOString(),
    });
    addLog('info', 'App mounted', `session=${sessionId.slice(0, 8)}`);
  }, []);

  // ── Logs ──────────────────────────────────────────────────────────────────
  const sendLog = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal') => {
    AllStak.log[level](logMsg, {
      url: window.location.href,
      component: 'LogsSection',
      framework: 'react',
      timestamp: new Date().toISOString(),
    });
    addLog(level, `log.${level}()`, logMsg);
  };

  // ── Errors ────────────────────────────────────────────────────────────────
  const throwTypeError = () => {
    try {
      const x = null as any;
      x.property;
    } catch (err: any) {
      AllStak.captureException(err, { component: 'App', action: 'throwTypeError' });
      addLog('error', 'captureException', `TypeError: ${err.message}`);
    }
  };

  const throwCustomError = () => {
    class APIError extends Error {
      statusCode: number;
      constructor(msg: string, code: number) {
        super(msg); this.name = 'APIError'; this.statusCode = code;
      }
    }
    try {
      throw new APIError('Failed to fetch user profile: 503 Service Unavailable', 503);
    } catch (err: any) {
      AllStak.captureException(err, { statusCode: err.statusCode, endpoint: '/api/users/me' });
      addLog('error', 'captureException', `APIError: ${err.message}`);
    }
  };

  const triggerUnhandledRejection = () => {
    addLog('warn', 'unhandledrejection', 'Triggering rejected promise...');
    Promise.reject(new Error('React: async fetch failed — CORS policy'));
  };

  const captureMsg = (level: string) => {
    const msgs: Record<string, string> = {
      info: 'React: user completed onboarding step 3/3',
      warning: 'React: API rate limit at 85%',
      error: 'React: payment timeout after 3 retries',
    };
    AllStak.captureMessage(msgs[level], level as any);
    addLog(level, 'captureMessage', msgs[level]);
  };

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const captureHTTP = (direction: 'inbound' | 'outbound') => {
    AllStak.captureRequest({
      direction,
      method: httpMethod as any,
      host: direction === 'inbound' ? 'app.allstak-react.com' : 'api.external.com',
      path: httpPath,
      statusCode: httpStatus,
      durationMs: httpDuration,
      userId: 'react-user-1',
      traceId: `trace-react-${Date.now()}`,
    });
    addLog('sent', `captureRequest(${direction})`, `${httpMethod} ${httpPath} → ${httpStatus} (${httpDuration}ms)`);
  };

  const simulatePurchaseFlow = () => {
    const journey = [
      { method: 'GET' as const, path: '/api/products', statusCode: 200, durationMs: 85 },
      { method: 'GET' as const, path: '/api/products/42', statusCode: 200, durationMs: 45 },
      { method: 'POST' as const, path: '/api/cart/items', statusCode: 201, durationMs: 156 },
      { method: 'GET' as const, path: '/api/cart', statusCode: 200, durationMs: 38 },
      { method: 'POST' as const, path: '/api/checkout/address', statusCode: 200, durationMs: 95 },
      { method: 'POST' as const, path: '/api/checkout/payment', statusCode: 201, durationMs: 1240 },
      { method: 'GET' as const, path: '/api/orders/ord-9f8e7d', statusCode: 200, durationMs: 62 },
    ];
    journey.forEach((r) => AllStak.captureRequest({ direction: 'inbound', method: r.method, host: 'app.allstak-react.com', path: r.path, statusCode: r.statusCode, durationMs: r.durationMs, userId: 'react-user-1' }));
    addLog('sent', 'simulatePurchaseFlow', `${journey.length} requests captured`);
  };

  // ── Cron ──────────────────────────────────────────────────────────────────
  const sendHeartbeat = (status: 'success' | 'failed') => {
    AllStak.heartbeat({ slug: cronSlug, status, durationMs: cronDuration, message: cronMessage || undefined });
    addLog(status === 'success' ? 'sent' : 'error', `heartbeat(${status})`, `${cronSlug} — ${cronDuration}ms`);
  };

  const runCronScenarios = async () => {
    const jobs = [
      { slug: 'react-cache-warm', status: 'success' as const, durationMs: 800, message: 'Warmed 1,234 cache keys' },
      { slug: 'react-analytics-flush', status: 'success' as const, durationMs: 3400, message: 'Flushed 89,420 events' },
      { slug: 'react-email-queue', status: 'failed' as const, durationMs: 12000, message: 'SMTP connection refused' },
      { slug: 'react-image-resize', status: 'success' as const, durationMs: 5600, message: 'Processed 342 images' },
    ];
    for (const job of jobs) {
      AllStak.heartbeat(job);
      addLog(job.status === 'success' ? 'sent' : 'error', `heartbeat(${job.status})`, `${job.slug}: ${job.message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // ── Session Replay ────────────────────────────────────────────────────────
  const generateClicks = () => {
    const btns = document.querySelectorAll<HTMLButtonElement>('button');
    let i = 0;
    const t = setInterval(() => {
      if (i >= Math.min(10, btns.length)) { clearInterval(t); addLog('event', 'sessionReplay', '10 click events recorded'); return; }
      const r = btns[i].getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('click', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
      i++;
    }, 150);
  };

  // ── User / Context ────────────────────────────────────────────────────────
  const applyContext = () => {
    AllStak.setUser({ id: userId, email: userEmail });
    AllStak.setTag(tagKey, tagVal);
    AllStak.log.info('React: full context test', { userId, email: userEmail, tag: `${tagKey}=${tagVal}`, screen: `${screen.width}x${screen.height}` });
    addLog('info', 'setUser+setTag+log', `${userId} / ${tagKey}=${tagVal}`);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const levelColor: Record<string, string> = {
    debug: '#64748b', info: '#818cf8', warn: '#eab308', warning: '#eab308',
    error: '#f87171', fatal: '#f97316', sent: '#4ade80', event: '#c084fc',
  };

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <h1 style={styles.title}>AllStak React SDK Demo</h1>
        <div style={styles.statusBar}>
          <span style={styles.dot} />
          <span style={{ color: '#94a3b8', fontSize: 13 }}>
            env: react-example · session: {sessionId.slice(0, 12)}… · Vite + React
          </span>
        </div>
      </div>

      <div style={styles.grid}>
        {/* Logs */}
        <Card title="Logs">
          <input style={styles.input} value={logMsg} onChange={(e) => setLogMsg(e.target.value)} placeholder="Message..." />
          <div style={styles.btnRow}>
            <Btn label="DEBUG" color="#475569" onClick={() => sendLog('debug')} />
            <Btn label="INFO" color="#6366f1" onClick={() => sendLog('info')} />
            <Btn label="WARN" color="#eab308" onClick={() => sendLog('warn')} />
            <Btn label="ERROR" color="#ef4444" onClick={() => sendLog('error')} />
            <Btn label="FATAL" color="#f97316" onClick={() => sendLog('fatal')} />
          </div>
        </Card>

        {/* Errors */}
        <Card title="Error Capture">
          <div style={styles.btnRow}>
            <Btn label="TypeError" color="#ef4444" onClick={throwTypeError} />
            <Btn label="APIError" color="#ef4444" onClick={throwCustomError} />
            <Btn label="Unhandled" color="#f97316" onClick={triggerUnhandledRejection} />
          </div>
          <div style={{ ...styles.btnRow, marginTop: 6 }}>
            <Btn label="msg: info" color="#6366f1" onClick={() => captureMsg('info')} />
            <Btn label="msg: warning" color="#eab308" onClick={() => captureMsg('warning')} />
            <Btn label="msg: error" color="#ef4444" onClick={() => captureMsg('error')} />
          </div>
        </Card>

        {/* HTTP */}
        <Card title="HTTP Request Tracing">
          <div style={styles.inputRow}>
            <select style={styles.input} value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)}>
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => <option key={m}>{m}</option>)}
            </select>
            <input style={styles.input} value={httpPath} onChange={(e) => setHttpPath(e.target.value)} />
          </div>
          <div style={styles.inputRow}>
            <input style={styles.input} type="number" value={httpStatus} onChange={(e) => setHttpStatus(+e.target.value)} placeholder="200" />
            <input style={styles.input} type="number" value={httpDuration} onChange={(e) => setHttpDuration(+e.target.value)} placeholder="ms" />
          </div>
          <div style={styles.btnRow}>
            <Btn label="Inbound" color="#3b82f6" onClick={() => captureHTTP('inbound')} />
            <Btn label="Outbound" color="#8b5cf6" onClick={() => captureHTTP('outbound')} />
            <Btn label="Purchase Flow (7)" color="#475569" onClick={simulatePurchaseFlow} />
          </div>
        </Card>

        {/* Cron */}
        <Card title="Cron Heartbeats">
          <div style={styles.inputRow}>
            <input style={styles.input} value={cronSlug} onChange={(e) => setCronSlug(e.target.value)} placeholder="job-slug" />
            <input style={styles.input} type="number" value={cronDuration} onChange={(e) => setCronDuration(+e.target.value)} placeholder="ms" />
          </div>
          <input style={{ ...styles.input, marginBottom: 8 }} value={cronMessage} onChange={(e) => setCronMessage(e.target.value)} placeholder="message (optional)" />
          <div style={styles.btnRow}>
            <Btn label="Success" color="#22c55e" onClick={() => sendHeartbeat('success')} />
            <Btn label="Failed" color="#ef4444" onClick={() => sendHeartbeat('failed')} />
            <Btn label="Run 4 scenarios" color="#475569" onClick={runCronScenarios} />
          </div>
        </Card>

        {/* Session Replay */}
        <Card title="Session Replay">
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
            Session replay is auto-started. Interact with the page to generate events. Flushes every 10s or 50 events.
          </div>
          <div style={{ fontSize: 11, color: '#6366f1', fontFamily: 'monospace', marginBottom: 10 }}>
            Session: {sessionId.slice(0, 24)}…
          </div>
          <input
            style={styles.input}
            type="password"
            value={masked}
            onChange={(e) => { setMasked(e.target.value); addLog('event', 'sessionReplay', 'input event (masked)'); }}
            placeholder="Type a password (will be masked in replay)…"
          />
          <div style={{ ...styles.btnRow, marginTop: 8 }}>
            <Btn label="Generate 10 clicks" color="#8b5cf6" onClick={generateClicks} />
            <Btn label="Scroll" color="#6366f1" onClick={() => { window.scrollBy(0, 300); setTimeout(() => window.scrollTo(0, 0), 600); addLog('event', 'sessionReplay', 'scroll event'); }} />
          </div>
        </Card>

        {/* User Context */}
        <Card title="User Context & Tags">
          <div style={styles.inputRow}>
            <input style={styles.input} value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="User ID" />
            <input style={styles.input} value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="Email" />
          </div>
          <div style={styles.inputRow}>
            <input style={styles.input} value={tagKey} onChange={(e) => setTagKey(e.target.value)} placeholder="tag key" />
            <input style={styles.input} value={tagVal} onChange={(e) => setTagVal(e.target.value)} placeholder="tag value" />
          </div>
          <Btn label="Apply User + Tag + Send Log" color="#6366f1" onClick={applyContext} />
        </Card>
      </div>

      {/* Activity Log */}
      <div style={styles.logWrap}>
        <div style={styles.logHeader}>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>Activity Log ({logs.length})</span>
          <button style={{ ...styles.btn, background: '#334155', fontSize: 11, padding: '3px 10px' }} onClick={clearLogs}>Clear</button>
        </div>
        <div style={styles.logPanel}>
          {logs.length === 0 && <p style={{ color: '#475569', fontSize: 12 }}>Click buttons above to generate SDK events…</p>}
          {logs.map((l) => (
            <div key={l.id} style={styles.logRow}>
              <span style={{ color: '#475569', minWidth: 75, fontSize: 11 }}>{l.time}</span>
              <span style={{ color: levelColor[l.level] ?? '#94a3b8', minWidth: 55, fontSize: 11, fontWeight: 600 }}>{l.level.toUpperCase()}</span>
              <span style={{ color: '#818cf8', fontSize: 11 }}>{l.action}</span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}> — {l.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { background: '#0f1117', minHeight: '100vh', padding: '2rem', fontFamily: 'system-ui, sans-serif', color: '#e2e8f0' },
  header: { marginBottom: '1.5rem' },
  title: { color: '#6366f1', fontSize: 22, margin: 0, marginBottom: 8 },
  statusBar: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14, marginBottom: 20 },
  card: { background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: '1.1rem' },
  cardTitle: { fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10, margin: '0 0 10px 0' },
  btn: { padding: '6px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'white', flex: 1 },
  btnRow: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  input: { background: '#0f1117', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0', padding: '6px 8px', fontSize: 12, width: '100%', marginBottom: 6, boxSizing: 'border-box' as const },
  inputRow: { display: 'flex', gap: 6 },
  logWrap: { background: '#1e293b', border: '1px solid #334155', borderRadius: 10, overflow: 'hidden' },
  logHeader: { padding: '10px 14px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logPanel: { padding: '10px 14px', maxHeight: 260, overflowY: 'auto', fontFamily: 'monospace' },
  logRow: { display: 'flex', gap: 8, padding: '2px 0', borderBottom: '1px solid #1e293b' },
};
