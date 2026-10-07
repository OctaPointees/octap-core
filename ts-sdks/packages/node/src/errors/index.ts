export class OctaSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OctaSdkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OctaApiError extends OctaSdkError {
  public readonly statusCode: number;
  public readonly statusText: string;
  public readonly responseBody: unknown;

  constructor(
    statusCode: number,
    statusText: string,
    responseBody: unknown,
    message?: string,
  ) {
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
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
