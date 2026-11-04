---
title: Frontend quickstart
description: Add Google sign-in to your website and prove the customer to your backend.
---

Add sign-in the way you would add Firebase Auth. You never handle OAuth nonces, ephemeral keys, zero-knowledge proofs or Enoki.

You need your OctaP API URL, your organization ID and OctaP's Google client ID, with your site's origin added to that client.

## 1. Create the auth object

```ts title="auth.ts"
import { createOctapAuth } from '@octap/browser-sdk';

export const auth = createOctapAuth({
  apiBaseUrl: 'https://your-octap-api.example',
  organizationId: 'your-organization-id',
  googleClientId: 'octap-google-client-id',
});
```

None of these values are secret. The API key stays on your server.

## 2. Show the button

```html
<div id="sign-in"></div>
```

```ts
await auth.renderGoogleButton(document.getElementById('sign-in'), {
  onError: (error) => showMessage(error.message),
});
```

Signing in also enrolls the customer in your organization. The button renders nothing while a customer is signed in, and returns when they sign out or their session expires.

## 3. React to the signed-in customer

```ts
auth.onAuthStateChanged((user) => {
  if (user) {
    // { endUserId, memberId, suiAddress }
    showAccount(user.memberId);
  } else {
    showSignedOut();
  }
});
```

The listener also runs once on load, after a reload restores the session. `auth.currentUser` gives the same value at any time.

## 4. Call your backend

Send the customer's token to your backend, and [verify it there](/guides/verify-a-customer/). Never trust a member ID your frontend sends on its own.

```ts
const response = await fetch('/api/balance', {
  method: 'POST',
  headers: { authorization: `Bearer ${await auth.getIdToken()}` },
});
```

Balance, history and voucher calls need your API key, so they run on your backend through `@octap/sdk`. The Browser SDK does not make them.

## 5. Sign out

```ts
await auth.signOut();
```

## Next steps

- [Claim a paid voucher](/guides/claim-a-paid-voucher/), where the customer signs on this device
- [OctapAuth reference](/reference/browser/octap-auth/), including where the session is stored and what that risks
