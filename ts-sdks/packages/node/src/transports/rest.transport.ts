/** REST transport configuration for HTTP requests. */
export interface RestTransport {
  kind: 'rest';
  baseUrl: string;
  fetchFn?: typeof fetch;
  customHeaders?: Record<string, string>;
}
