/**
 * shared/marshal.ts — [PDC: Marshalling]
 *
 * MARSHALLING = turning a call (method name + arguments), its reply, or an
 * error into bytes that can travel between two computers, and UNMARSHALLING =
 * turning those bytes back into objects on the other side.
 *
 * Every remote call between central and an island goes through this file,
 * whichever of the three transports carries it:
 *
 *   1. gRPC on a LAN    : JSON body inside the protobuf message Invocation
 *                         { method, json } (gRPC then encodes that message
 *                         as protobuf binary — see proto/booking.proto)
 *   2. WebSocket link   : JSON text frames { t, id, m, p } (shared/link.ts)
 *   3. HTTPS polling    : the same frames in HTTP request bodies (central/poll.ts)
 *
 * Errors are marshalled too, with a code that mirrors gRPC status names
 * (UNAVAILABLE, DEADLINE_EXCEEDED, NOT_FOUND …), so central handles a failure
 * the same way whichever transport reported it.
 *
 *   caller                        wire                         callee
 *   ──────                        ────                         ──────
 *   request object ─ marshal ─▶ JSON / protobuf ─ unmarshal ─▶ handler(request)
 *   reply object  ◀ unmarshal ─ JSON / protobuf ◀─ marshal ─── result or error
 */

// ---------------------------------------------------------------------------
// 1. Values: object <-> JSON text
// ---------------------------------------------------------------------------

// Object -> text for the wire.
export function marshal(value: unknown): string {
  return JSON.stringify(value ?? {});
}

// Text from the wire -> object. Empty or broken text becomes `fallback`
// instead of crashing the receiver.
export function unmarshal<T = Record<string, unknown>>(text: string | undefined | null, fallback = {} as T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 2. Errors: Error <-> { code, message }
// ---------------------------------------------------------------------------

// An error that crossed the network. `code` uses gRPC status names.
export class LinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// How an error travels inside a reply.
export interface WireError { code: string; message: string }

// Any thrown error -> wire form (unknown errors become INTERNAL).
export function errorToWire(err: unknown): WireError {
  const e = err as { code?: string; message?: string };
  return { code: typeof e?.code === 'string' ? e.code : 'INTERNAL', message: e?.message ?? String(err) };
}

// Wire form -> LinkError on the caller's side.
export function errorFromWire(e: Partial<WireError> | undefined): LinkError {
  return new LinkError(e?.code ?? 'INTERNAL', e?.message ?? 'remote error');
}

// Readable text of an error from any transport (gRPC errors carry `details`).
export function errorText(err: unknown): string {
  const e = err as { details?: string; message?: string };
  return e.details || e.message || String(err);
}

// ---------------------------------------------------------------------------
// 3. gRPC envelope: Invocation { method, json }   (transport 1)
// ---------------------------------------------------------------------------

// The protobuf message every island method travels in (proto/booking.proto).
export interface Invocation { method: string; json: string }

// Caller: method + request -> Invocation.
export const toInvocation = (method: string, request: unknown): Invocation => ({ method, json: marshal(request) });

// Callee or caller: Invocation -> request / reply object.
export const fromInvocation = <T>(inv: Invocation): T => unmarshal<T>(inv.json);

// gRPC only carries a numeric status and a text, so the error code is put in
// front of the text ("NOT_FOUND: Booking not found") and read back here.
export const grpcErrorDetails = (err: unknown): string => {
  const e = errorToWire(err);
  return `${e.code}: ${e.message}`;
};
export function errorFromGrpc(err: unknown): Error {
  const m = /^([A-Z_]+): (.*)$/s.exec(errorText(err));
  return m ? new LinkError(m[1], m[2]) : (err as Error);
}

// ---------------------------------------------------------------------------
// 4. Link frames (transports 2 and 3)
// ---------------------------------------------------------------------------
//   { t: "hello", island, ts, sig }            island -> central, first frame (auth)
//   { t: "welcome", island }                   central -> island, handshake accepted
//   { t: "req", id, m, p }                     a call: method m with payload p
//   { t: "res", id, ok: true,  p }             successful reply to call `id`
//   { t: "res", id, ok: false, e: WireError }  failed reply

export type Frame =
  | { t: 'hello'; island: string; ts: number; sig: string }
  | { t: 'welcome'; island: string }
  | { t: 'req'; id: number; m: string; p: unknown }
  | { t: 'res'; id: number; ok: true; p: unknown }
  | { t: 'res'; id: number; ok: false; e: WireError };

// The reply part of a frame (also posted on its own when polling).
export type Reply = Extract<Frame, { t: 'res' }> | { id: number; ok: boolean; p?: unknown; e?: Partial<WireError> };

// Builders, so every frame is written the same way.
export const frame = {
  hello: (island: string, ts: number, sig: string): Frame => ({ t: 'hello', island, ts, sig }),
  welcome: (island: string): Frame => ({ t: 'welcome', island }),
  request: (id: number, method: string, payload: unknown): Frame => ({ t: 'req', id, m: method, p: payload }),
  ok: (id: number, result: unknown): Frame => ({ t: 'res', id, ok: true, p: result }),
  fail: (id: number, err: unknown): Frame => ({ t: 'res', id, ok: false, e: errorToWire(err) }),
};

// Text from a socket -> Frame, or null when it is not one of ours.
export function parseFrame(raw: string): Frame | null {
  const f = unmarshal<Frame | null>(raw, null);
  return f && typeof f === 'object' && typeof (f as { t?: unknown }).t === 'string' ? f : null;
}

// Settles a reply: the result, or throws the remote error.
export function replyValue(r: Reply): unknown {
  if (r.ok) return (r as { p?: unknown }).p;
  throw errorFromWire((r as { e?: Partial<WireError> }).e);
}
