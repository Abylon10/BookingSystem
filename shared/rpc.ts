import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { ROOT } from './config.ts';

const definition = protoLoader.loadSync(join(ROOT, 'proto', 'booking.proto'), {
  keepCase: true,   // keep snake_case field names exactly as in the .proto
  longs: Number,
  defaults: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = (grpc.loadPackageDefinition(definition) as any).biliran.booking.v1;

export const IslandService = pkg.IslandService as grpc.ServiceClientConstructor;
export const CentralService = pkg.CentralService as grpc.ServiceClientConstructor;

// Promisified unary call with a deadline, so one slow island cannot stall a fan-out.
export function call<Req, Res>(
  client: grpc.Client,
  method: string,
  request: Req,
  timeoutMs = 1500,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[method](request, { deadline }, (err: grpc.ServiceError | null, res: Res) =>
      err ? reject(err) : resolve(res),
    );
  });
}

export { grpc };
