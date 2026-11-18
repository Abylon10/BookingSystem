/**
 * shared/link.ts — [PDC: RPC over WebSocket] [PDC: Client-server communication]
 *
 * RPC over a WebSocket "island link", used when central runs in the cloud.
 *
 * Why: an island laptop on home Wi-Fi or mobile data has no public address
 * (routers and carrier-grade NAT block incoming connections), so central cannot
 * call it directly. Instead each island opens ONE outgoing WebSocket to central
 * and keeps it open. Both sides then send RPC requests over that same socket:
 *   central -> island : SearchAvailability, HoldBooking, ConfirmBooking, ...
 *   island  -> central: PushEvents (outbox sync)
 * Only the transport differs from the direct gRPC mode used on a shared LAN:
 * the method names, request bodies and error codes are the same, and all of
 * them are marshalled by shared/marshal.ts.
 *
 * A Peer is one end of the link. It can CALL the other side (client role) and
 * ANSWER calls from it (server role) at the same time; replies are matched to
 * calls by a request id, so many calls can be in flight at once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { frame, marshal, parseFrame, replyValue, LinkError, type Frame } from './marshal.ts';

// Kept here as well, so existing imports from link.ts keep working.
export { LinkError, errorText } from './marshal.ts';

// A handler answers one method; it may return a value or a promise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handlers = Record<string, (req: any) => unknown>;

// ---------------------------------------------------------------------------
// [PDC: Security] Handshake: proves the island knows the shared TICKET_SECRET
// ---------------------------------------------------------------------------

// Signature for an island's hello frame. "link:" keeps it separate from other
// signatures made with the same secret.
export function helloSignature(secret: string, island: string, ts: number): string {
  return createHmac('sha256', secret).update(`link:${island}:${ts}`).digest('hex');
}

// Checks a hello frame: right signature, and a timestamp within 5 minutes so an
// old captured hello cannot be replayed later.
export function verifyHello(secret: string, island: string, ts: number, sig: string): boolean {
  if (Math.abs(Date.now() - ts) > 5 * 60_000) return false;
  const expected = Buffer.from(helloSignature(secret, island, ts), 'hex');
  const given = Buffer.from(String(sig), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Peer: one end of a link, able to both call and answer
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class Peer {
  private readonly ws: WebSocket;
  private readonly handlers: Handlers;
  private nextId = 1;
  // Calls sent and still waiting for their reply, by request id.
  private readonly pending = new Map<number, Pending>();

  constructor(ws: WebSocket, handlers: Handlers) {
    this.ws = ws;
    this.handlers = handlers;

    // Incoming frames: requests are answered, replies settle our own calls.
    ws.on('message', (data) => this.onMessage(data.toString()));

    // [PDC: Fault tolerance] Link lost: every call still waiting fails at once
    // instead of hanging until its timeout, so central reports the island
    // offline immediately.
    ws.on('close', () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new LinkError('UNAVAILABLE', 'island link closed'));
        this.pending.delete(id);
      }
    });
  }

  get open(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  // Closes the link; pending calls fail with UNAVAILABLE (see constructor).
  // Code 4010 tells the island to switch to HTTPS polling.
  close(code = 4000, reason = 'replaced'): void {
    this.ws.close(code, reason);
  }

  // [PDC: RPC client] Calls a method on the other side. Fails with
  // DEADLINE_EXCEEDED after timeoutMs, like a gRPC deadline, so one slow
  // island cannot stall a search.
  call<Res>(method: string, payload: unknown, timeoutMs = 1500): Promise<Res> {
    if (!this.open) return Promise.reject(new LinkError('UNAVAILABLE', 'island link not open'));
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError('DEADLINE_EXCEEDED', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(frame.request(id, method, payload));
    });
  }

  // Dispatches one incoming frame.
  private async onMessage(raw: string): Promise<void> {
    const msg = parseFrame(raw);
    if (!msg) return; // not ours; ignore

    // A reply to one of our calls.
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return; // already timed out
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      try { p.resolve(replyValue(msg)); } catch (err) { p.reject(err as Error); }
      return;
    }

    // [PDC: RPC server] A call from the other side: run the handler and
    // send back the result (or the error, marshalled with its code).
    if (msg.t === 'req') {
      const handler = this.handlers[msg.m];
      try {
        if (!handler) throw new LinkError('UNIMPLEMENTED', `no handler for ${msg.m}`);
        this.send(frame.ok(msg.id, await handler(msg.p ?? {})));
      } catch (err) {
        this.send(frame.fail(msg.id, err));
      }
    }
  }

  private send(f: Frame): void {
    if (this.open) this.ws.send(marshal(f));
  }
}
