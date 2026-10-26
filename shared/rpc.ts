/**
 * shared/rpc.ts
 *
 * gRPC plumbing shared by central and the islands. Loads proto/booking.proto at
 * runtime (no code generation step) and exposes:
 *  - IslandService / CentralService constructors (to create clients or servers)
 *  - call(): a promise-based unary call with a deadline
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { ROOT } from './config.ts';

// Parse the .proto contract.
//   keepCase: keep snake_case field names exactly as written in the .proto
//   longs:    turn int64 fields (timestamps) into plain JS numbers
//   defaults: fill missing fields with their default value ("" / 0 / false)
const definition = protoLoader.loadSync(join(ROOT, 'proto', 'booking.proto'), {
  keepCase: true,
  longs: Number,
  defaults: true,
});

// Walk down to our package "biliran.booking.v1". The loaded object is untyped
// because it is built at runtime from the .proto file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = (grpc.loadPackageDefinition(definition) as any).biliran.booking.v1;

// Service constructors. `new IslandService(address, creds)` creates a client;
// `IslandService.service` is the definition passed to server.addService().
export const IslandService = pkg.IslandService as grpc.ServiceClientConstructor;
export const CentralService = pkg.CentralService as grpc.ServiceClientConstructor;

// Makes one unary RPC and returns a promise.
// The deadline matters for distribution: when an island is slow or offline the
// call fails after `timeoutMs` instead of hanging, so a parallel search can
// still answer with the islands that did respond.
export function call<Req, Res>(
  client: grpc.Client,
  method: string,
  request: Req,
  timeoutMs = 1500,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs);
    // Methods are attached to the client at runtime, so they are looked up by name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[method](request, { deadline }, (err: grpc.ServiceError | null, res: Res) =>
      err ? reject(err) : resolve(res),
    );
  });
}

// Re-exported so other modules import grpc from one place.
export { grpc };
