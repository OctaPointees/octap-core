import { Injectable } from '@nestjs/common';
/** Vendor adapter slot for clickhouse; no SDK instance, HTTP calls or connection. */
@Injectable()
export class ClickhouseClient {}
