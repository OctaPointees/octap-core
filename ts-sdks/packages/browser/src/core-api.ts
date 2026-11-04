import { OctapAuthError } from './errors.js';

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

/** Reads a body once, whatever its type: an error page must not surface as a `TypeError`. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(response: Response, body: unknown): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    return String((body as { message: unknown }).message);
  }
  return `OctaP request failed: ${response.status} ${response.statusText}`.trim();
}

/** The public Core routes a customer's device may call. It holds no credential of any kind. */
export class CoreApi {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch,
    private readonly defaultTimeoutMs: number,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async post<T>(path: string, payload: unknown, options: RequestOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    let body: unknown;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      body = await readBody(response);
    } catch (err: unknown) {
      if (options.signal?.aborted) {
        throw new OctapAuthError('aborted', 'The request was aborted.');
      }
      if (timeout.aborted) {
        throw new OctapAuthError('timeout', 'The request timed out.');
      }
      throw new OctapAuthError('network-error', `Could not reach OctaP: ${(err as Error)?.message ?? String(err)}`);
    }

    if (!response.ok) {
      throw new OctapAuthError('api-error', errorMessage(response, body), { status: response.status, body });
    }
    if (typeof body !== 'object' || body === null) {
      throw new OctapAuthError('invalid-response', 'OctaP returned a response this SDK cannot read.', {
        status: response.status,
        body,
      });
    }
    return body as T;
  }
}
