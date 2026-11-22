# mcp-auth

OAuth 2.1 authorization server for MCP hosts (OCT-293). A Business Owner or Business Developer signs
in to the OctaP MCP server with the same Google account they use on the Console, and the host gets a
short-lived access token bound to that user, one organization and their persona there.

## Flow

1. The MCP server (`octap-mcp serve-http`) answers an unauthenticated request with 401 and its
   RFC 9728 metadata, which names Core as the authorization server.
2. The host reads `/.well-known/oauth-authorization-server` and registers at `POST /oauth/register`
   (RFC 7591, public clients only). The client id is self-contained and HMAC-signed with
   `MCP_OAUTH_SIGNING_KEY`, so registration stores nothing.
3. `GET /oauth/authorize` (PKCE S256 required, `scope=mcp`, optional RFC 8707 `resource`) shows a
   page with Google sign-in. The Google ID token must carry the request id as its `nonce`, so a token
   minted for the Console or another request is refused. A user in several organizations picks one.
4. `POST /oauth/token` exchanges the one-time code (60 s) for an opaque `octap_mcp_…` token (1 h).
   `POST /oauth/revoke` deletes one. There are no refresh tokens: the host signs in again.

Pending requests, codes and tokens live in Redis under SHA-256 keys with their TTL.

## Using a token

`ConsoleAccessGuard` accepts an MCP token on `/v1/console/...` routes alongside the Google ID token,
narrowed to GET requests, to the bound organization's `:organizationId` (another organization is
403), and never on platform-admin routes. Every use reloads the user's memberships: a suspended
membership or a changed persona drops the token (401). The route's own membership and persona checks
still run. `GET /v1/console/mcp/token` tells the MCP server what a token is bound to; `GET
/v1/console/me` with a token lists only the bound organization.

## Configuration

`MCP_OAUTH_ISSUER_URL` (Core's public origin, no path) and `MCP_OAUTH_SIGNING_KEY` (32-byte base64);
unset, these routes answer 503. The sign-in page runs Google Identity Services on Core's origin, so
add that origin to the authorized JavaScript origins of the `CONSOLE_GOOGLE_CLIENT_ID` client.

## Known gaps

- No refresh tokens; tokens last one hour.
- No per-user audit trail of tool calls yet (OCT-296).
- One persona's tool set for everyone; persona-based tool sets are OCT-294.
- A lost Redis signs everyone out; registered clients survive (they are stateless).
