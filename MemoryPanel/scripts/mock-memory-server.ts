/**
 * Mock memory service (for local end-to-end integration).
 *
 * Starts a standalone Hono instance listening on `MOCK_KERNEL_PORT` (default 9090),
 * receiving all aggregate-type upserts / deletes delivered by the main service's Outbox worker.
 *
 * - POST /internal/sync/:aggregate     → stored in the received array + printed to stdout
 * - POST /internal/sync/:aggregate/delete → same as above, event_type=delete
 * - GET  /__received                   → returns the list of received events (handy for assertions / debugging)
 * - DELETE /__received                 → clears it (handy for multi-round integration)
 *
 * Start: `tsx scripts/mock-memory-server.ts`
 *
 * Connect the main service: `KERNEL_ENABLED=true KERNEL_BASE_URL=http://127.0.0.1:9090 pnpm dev`
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

interface ReceivedEvent {
  ts: string;
  aggregate: string;
  event_type: 'upsert' | 'delete';
  payload: unknown;
}

const received: ReceivedEvent[] = [];

const app = new Hono();

app.get('/__received', (c) => c.json(received));
app.delete('/__received', (c) => {
  received.length = 0;
  return c.json({ ok: true });
});

// upsert: /internal/sync/:aggregate
app.post('/internal/sync/:aggregate', async (c) => {
  const aggregate = c.req.param('aggregate');
  const payload = await c.req.json().catch(() => ({}));
  const ev: ReceivedEvent = {
    ts: new Date().toISOString(),
    aggregate,
    event_type: 'upsert',
    payload,
  };
  received.push(ev);
  // One line of JSON, easy to grep
  console.log(JSON.stringify({ tag: 'mock-kernel', ...ev }));
  return c.json({ ok: true });
});

// delete: /internal/sync/:aggregate/delete
app.post('/internal/sync/:aggregate/delete', async (c) => {
  const aggregate = c.req.param('aggregate');
  const payload = await c.req.json().catch(() => ({}));
  const ev: ReceivedEvent = {
    ts: new Date().toISOString(),
    aggregate,
    event_type: 'delete',
    payload,
  };
  received.push(ev);
  console.log(JSON.stringify({ tag: 'mock-kernel', ...ev }));
  return c.json({ ok: true });
});

const port = Number(process.env.MOCK_KERNEL_PORT ?? 9090);
serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`mock-kernel listening on http://127.0.0.1:${info.port}`);
});
