import type { RestTransport } from './rest.transport.js';
import type { GrpcTransport } from './grpc.transport.js';
export type { RestTransport, GrpcTransport };
export type Transport = RestTransport | GrpcTransport;
