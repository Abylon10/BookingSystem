/**
 * central/poll.ts
 *
 * HTTPS long-polling fallback for the island link.
 *
 * Some networks (school/office Wi-Fi, proxies, antivirus "web shields") let
 * ordinary HTTPS requests through but block or break WebSocket connections.
 * An island on such a network switches to polling:
 *
 *   island ── POST /island-poll/next ──► central   "any calls for me?"
 *          ◄── { requests: [...] } ───────          (answered at once if a call
 *                                                    is waiting, else after ~20 s)
 *   island ── POST /island-poll/reply ─► central   result of each call
 *   island ── POST /island-poll/events ► central   outbox sync (PushEvents)
 *
 * Every request carries "X-Island-Auth: <island>.<ms>.<hmac>", signed with the
 * shared TICKET_SECRET exactly like the WebSocket hello.
 */
import type express from 'express';
import { LinkError, verifyHello } from '../shared/link.ts';

// How long one poll request waits for work before answering empty. Kept under
// common 30 s proxy timeouts.
const POLL_WAIT_MS = 20_000;
// An island counts as connected while it polled within this window.
const ALIVE_MS = POLL_WAIT_MS + 15_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: LinkError) => void;
  timer: NodeJS.Timeout;
}
interface Call { id: number; m: string; p: unknown }

// One polling island, seen from central. Same surface as the WebSocket Peer
// (`open`, `call`, `close`), so central's routing code treats both alike.
export class PollPeer {
  readonly kind = 'poll';
  private nextId = 1;
  private lastSeen = Date.now();
  private queue: Call[] = [];
  private waiter: ((calls: Call[]) => void) | null = null;
  private readonly pending = new Map<number, Pending>();

  get open(): boolean {
    return Date.now() - this.lastSeen < ALIVE_MS;
  }

  // Queues a call for the island; it is delivered on the island's next poll
  // (immediately, if a poll is already waiting).
  call<Res>(method: string, payload: unknown, timeoutMs = 1500): Promise<Res> {
    if (!this.open) return Promise.reject(new LinkError('UNAVAILABLE', 'island is not polling'));
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.queue = this.queue.filter((c) => c.id !== id);
        reject(new LinkError('DEADLINE_EXCEEDED', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.queue.push({ id, m: method, p: payload });
      this.flush();
    });
  }

  // Hands queued calls to a waiting poll.
  private flush(): void {
    if (this.waiter && this.queue.length) {
      const deliver = this.waiter;
      this.waiter = null;
      deliver(this.queue.splice(0));
    }
  }

  // Called for each poll request: returns queued calls now, or waits up to
  // waitMs (default POLL_WAIT_MS) for one to arrive. The island's very first
  // poll uses wait 0 so it learns at once that it is connected.
  next(waitMs = POLL_WAIT_MS): Promise<Call[]> {
    this.lastSeen = Date.now();
    if (this.queue.length || waitMs <= 0) return Promise.resolve(this.queue.splice(0));
    this.waiter?.([]); // a newer poll replaces an older one still waiting
    return new Promise((resolve) => {
      const deliver = (calls: Call[]) => { this.lastSeen = Date.now(); resolve(calls); };
      this.waiter = deliver;
      setTimeout(() => { if (this.waiter === deliver) { this.waiter = null; deliver([]); } }, Math.min(waitMs, POLL_WAIT_MS));
    });
  }

  // Settles a call with the island's reply.
  reply(r: { id: number; ok: boolean; p?: unknown; e?: { code?: string; message?: string } }): void {
    const p = this.pending.get(r.id);
    if (!p) return; // already timed out
    clearTimeout(p.timer);
    this.pending.delete(r.id);
    if (r.ok) p.resolve(r.p);
    else p.reject(new LinkError(r.e?.code ?? 'INTERNAL', r.e?.message ?? 'remote error'));
  }

  // Replaced by a WebSocket link: fail anything still waiting.
  close(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LinkError('UNAVAILABLE', 'island link replaced'));
      this.pending.delete(id);
    }
    this.lastSeen = 0;
  }
}

// What the polling routes need from server.ts.
interface Deps {
  secret: string;
  knownIslands: Set<string>;
  // Returns the island's current poll peer, creating it if needed.
  pollPeerFor: (islandId: string) => PollPeer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storeEvents: (events: any[]) => Promise<string[]>;
}

export function mountPolling(app: express.Express, { secret, knownIslands, pollPeerFor, storeEvents }: Deps): void {
  // Checks X-Island-Auth and returns the island id, or answers 401.
  const auth = (req: express.Request, res: express.Response): string | null => {
    const [island, ts, sig] = (req.get('X-Island-Auth') ?? '').split('.');
    if (!knownIslands.has(island) || !verifyHello(secret, island, Number(ts), sig ?? '')) {
      res.status(401).json({ error: 'not authorized' });
      return null;
    }
    return island;
  };

  // Long poll: deliver calls waiting for this island.
  app.post('/island-poll/next', async (req, res) => {
    const island = auth(req, res);
    if (!island) return;
    const wait = req.query.wait === undefined ? undefined : Number(req.query.wait);
    res.json({ requests: await pollPeerFor(island).next(wait) });
  });

  // Replies to delivered calls.
  app.post('/island-poll/reply', (req, res) => {
    const island = auth(req, res);
    if (!island) return;
    for (const r of [].concat(req.body ?? [])) pollPeerFor(island).reply(r);
    res.json({ ok: true });
  });

  // Outbox sync over plain HTTPS (PushEvents).
  app.post('/island-poll/events', async (req, res) => {
    const island = auth(req, res);
    if (!island) return;
    try {
      res.json({ accepted_event_ids: await storeEvents(req.body?.events ?? []) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
