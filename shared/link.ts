/**
 * shared/link.ts
 *
 * RPC over a WebSocket "island link", used when central runs in the cloud.
 *
 * Why: an island laptop on home Wi-Fi or mobile data has no public address
 * (routers and carrier-grade NAT block incoming connections), so central cannot
 * call it directly. Instead each island opens ONE outgoing WebSocket to central
 * and keeps it open. Both sides then send RPC requests over that same socket:
 *   central -> island : GetCatalog, RegisterOnlineBooking, CancelOnlineBooking, ...
 *   island  -> central: PushEvents (outbox sync)
 * The method names and message fields are the ones in proto/booking.proto; only
 * the transport differs from the direct gRPC mode used on a shared LAN.
 *
 * Wire format (JSON text frames):
 *   { t: "hello", island, ts, sig }        island -> central, first frame (auth)
 *   { t: "welcome", island }               central -> island, handshake accepted
 *   { t: "req", id, m, p }                 a call: method m with payload p
 *   { t: "res", id, ok: true,  p }         successful reply to request id
 *   { t: "res", id, ok: false, e: {code, message} }  failed reply
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';

// A handler answers one method; it may return a value or a promise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handlers = Record<string, (req: any) => unknown>;

// Error carried across the link. `code` mirrors gRPC status names
// (UNAVAILABLE, INTERNAL, DEADLINE_EXCEEDED, UNIMPLEMENTED) so central treats
// link errors and gRPC errors the same way.
export class LinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Handshake (proves the island knows the shared TICKET_SECRET)
// ---------------------------------------------------------------------------

// Signature for an island's hello frame. "link:" keeps it separate from ticket
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
  reject: (err: LinkError) => void;
  timer: NodeJS.Timeout;
}

export class Peer {
  private readonly ws: WebSocket;
  private readonly handlers: Handlers;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(ws: WebSocket, handlers: Handlers) {
    this.ws = ws;
    this.handlers = handlers;

    // Incoming frames: requests are answered, replies settle our own calls.
    ws.on('message', (data) => this.onMessage(data.toString()));

    // Link lost: every call still waiting fails at once instead of hanging
    // until its timeout, so central immediately reports the island offline.
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

  // Calls a method on the other side. Fails with DEADLINE_EXCEEDED after
  // timeoutMs, like a gRPC deadline, so one slow island cannot stall a search.
  call<Res>(method: string, payload: unknown, timeoutMs = 1500): Promise<Res> {
    if (!this.open) return Promise.reject(new LinkError('UNAVAILABLE', 'island link not open'));
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError('DEADLINE_EXCEEDED', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ t: 'req', id, m: method, p: payload }));
    });
  }

  // Dispatches one incoming frame.
  private async onMessage(raw: string): Promise<void> {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not ours; ignore
    }

    // A reply to one of our calls.
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return; // already timed out
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.p);
      else p.reject(new LinkError(msg.e?.code ?? 'INTERNAL', msg.e?.message ?? 'remote error'));
      return;
    }

    // A call from the other side: run the handler and send back the result.
    if (msg.t === 'req') {
      const handler = this.handlers[msg.m];
      try {
        if (!handler) throw new LinkError('UNIMPLEMENTED', `no handler for ${msg.m}`);
        const result = await handler(msg.p ?? {});
        this.send({ t: 'res', id: msg.id, ok: true, p: result });
      } catch (err) {
        const e = err as Partial<LinkError>;
        this.send({ t: 'res', id: msg.id, ok: false, e: { code: e.code ?? 'INTERNAL', message: e.message ?? String(err) } });
      }
    }
  }

  private send(frame: unknown): void {
    if (this.open) this.ws.send(JSON.stringify(frame));
  }
}

// Text of an error from either transport (gRPC errors carry `details`).
export function errorText(err: unknown): string {
  const e = err as { details?: string; message?: string };
  return e.details || e.message || String(err);
}
