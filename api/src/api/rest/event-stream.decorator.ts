import { SetMetadata } from '@nestjs/common';

export const EVENT_STREAM_KEY = 'octap:event-stream';

export interface EventStreamOptions {
  /** The OpenAPI description of the stream's success response: what each message holds. */
  description: string;
  /** The stream takes `Last-Event-ID` to resume after the last message received. */
  resumable?: boolean;
}

/**
 * Marks a handler that answers with Server-Sent Events, writing the response itself (`@Res()`), so
 * the OpenAPI document describes a `text/event-stream` success instead of a JSON body.
 */
export const EventStream = (options: EventStreamOptions) => SetMetadata(EVENT_STREAM_KEY, options);
