# Node merchant SDK
`src/client.ts` is the merchant client (points and vouchers) over the REST transport in
`src/transports/`. `src/errors/` holds `OctaSdkError` and `OctaApiError`.
Public DTOs come from the sibling contracts package. Do not import this package into browser code;
browser helpers have their own package.
