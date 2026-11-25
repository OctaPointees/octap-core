import { SetMetadata } from '@nestjs/common';

export const EVENT_STREAM_KEY = 'octap:event-stream';

/**
 * Marks a handler that answers with Server-Sent Events, writing the response itself (`@Res()`), so
 * the OpenAPI document describes a `text/event-stream` success instead of a JSON body.
 */
export const EventStream = () => SetMetadata(EVENT_STREAM_KEY, true);
