---
title: Verify a customer
description: Check on your backend who a request from your website really belongs to.
---

Your website sends the customer's token, and your backend checks it, like `verifyIdToken` in Firebase Admin. Do this before acting for a customer, and never trust a member ID your frontend sends.

## On your website

```ts
const response = await fetch('/api/balance', {
  method: 'POST',
  headers: { authorization: `Bearer ${await auth.getIdToken()}` },
});
```

## On your server

```ts
const idToken = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
const { memberId, active, suiAddress } = await client.verifyCustomer(idToken);

if (!memberId) {
  // A valid Google sign-in that has not enrolled in your organization yet.
} else if (!active) {
  // Enrolled, but blocked: reward operations for this member will be refused.
} else {
  const balance = await client.getBalance(memberId);
}
```

The call needs the `read` scope and writes nothing. An invalid or expired token throws `OctaApiError` with status 401.

## What the check proves

It proves who the customer is. It doesn't prove consent. All merchants share one Google client ID, so a token a customer showed to another merchant also verifies here.

Use it to decide whose data to show and whose account to act on. Anything that spends points still needs the customer's signature, and the SDK enforces that.

## Token expiry

Google's token lasts about an hour. When `getIdToken` finds it has expired, the customer is signed out, your `onAuthStateChanged` listener receives `null`, and the sign-in button returns.
