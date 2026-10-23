# Node merchant SDK
`src/client.ts` is the merchant client (points and vouchers) over the REST transport in
`src/transports/`. `src/errors/` holds `OctaSdkError` and `OctaApiError`. `src/webhooks.ts` is
the receiver side: `verifyWebhookSignature` checks `x-octap-signature`, and
`constructWebhookEvent` checks it and returns the typed `WebhookEvent` (discriminated on `type`).
Public DTOs come from the sibling contracts package. Do not import this package into browser code;
browser helpers have their own package.
