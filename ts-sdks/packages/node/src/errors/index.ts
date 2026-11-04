export class OctaSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OctaSdkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OctaApiError extends OctaSdkError {
  public readonly statusCode: number;
  public readonly statusText: string;
  public readonly responseBody: unknown;
  /** The `Retry-After` header, when Core sent one. */
  public readonly retryAfter?: string;

  constructor(statusCode: number, statusText: string, responseBody: unknown, message?: string, retryAfter?: string) {
    let msg = message;
    if (!msg) {
      if (typeof responseBody === 'object' && responseBody !== null && 'message' in responseBody) {
        const bodyMsg = (responseBody as { message: unknown }).message;
        msg = Array.isArray(bodyMsg) ? bodyMsg.join(', ') : String(bodyMsg);
      } else {
        msg = `API request failed with status ${statusCode} (${statusText})`;
      }
    }
    super(msg);
    this.name = 'OctaApiError';
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A request may have reached Core; inspect state before retrying a mutation. */
export class OctaNetworkError extends OctaSdkError {
  constructor(cause: unknown) {
    super('Network request failed', { cause });
    this.name = 'OctaNetworkError';
  }
}

/** Cancels local waiting only, not a server-side business operation. */
export class OctaRequestAbortedError extends OctaSdkError {
  constructor(cause?: unknown) {
    super('Request aborted', { cause });
    this.name = 'OctaRequestAbortedError';
  }
}
