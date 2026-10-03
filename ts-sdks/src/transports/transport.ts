/** Transport selection only; no HTTP or gRPC calls are implemented. */
export type Transport = RestTransport | GrpcTransport;
export interface RestTransport { kind: 'rest'; baseUrl: string; }
export interface GrpcTransport { kind: 'grpc'; address: string; }
