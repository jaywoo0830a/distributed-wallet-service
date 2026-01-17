# Wallet Deposit API (Polling-Based, Concurrency-Safe)

This document describes a **polling-based deposit pipeline API** designed for
e-commerce and payment workflows, with **strong concurrency safety** and
**idempotent capture semantics**.

The API is intentionally **asset-agnostic**, **asynchronous internally**, and
**synchronous/polling-only for clients**.

---

## Core Concepts

### DepositIntent

A `DepositIntent` represents a **single payment intention**:

- One receiving address
- One expected amount
- One expiration window
- Multiple observations over time
- Exactly **one possible capture**

Clients **poll** the DepositIntent to observe state changes.

---

## Design Goals

- Prevent double processing of deposits
- Ensure at-most-once capture
- Allow safe retries and concurrent requests
- Avoid tight coupling to e-commerce schemas
- Support arbitrary integrations via `reference` and `metadata`

---

## High-Level Flow

1. Client creates a `DepositIntent`
2. Address is provisioned asynchronously
3. Client polls until deposit becomes eligible
4. Client explicitly **captures** the deposit (exactly once)
5. Upstream systems (e.g. order creation) run **after capture**

---

## State Model

### DepositIntent Statuses

| Status | Meaning |
|------|--------|
| `CREATED` | Intent created |
| `ADDRESS_PENDING` | Address creation queued |
| `AWAITING_DEPOSIT` | Address ready, waiting for funds |
| `OBSERVED` | Funds detected and/or confirmations progressing |
| `ELIGIBLE` | Deposit satisfies all required conditions |
| `CAPTURE_PENDING` | Capture attempt in progress |
| `CAPTURED` | Deposit finalized (terminal) |
| `EXPIRED` | Expired without successful capture |
| `CANCELLED` | Cancelled by upstream system |
| `FAILED` | Internal failure |

> **Important:**  
> `ELIGIBLE` does **not** mean finalized.  
> Only `CAPTURED` is a terminal, at-most-once state.

---

## API Endpoints

### Create DepositIntent

`POST /v1/deposit-intents`

Creates a new deposit intent.  
Address provisioning happens asynchronously.

#### Request

```json
{
  "asset": "USDT",
  "network": "TRON",
  "expected_amount": "152.34",
  "expires_at": "2026-01-17T15:30:00Z",

  "policy": {
    "min_confirmations": 12,
    "allow_overpay": true,
    "allow_underpay": false
  },

  "reference": {
    "idempotency_key": "uuid-or-hash",
    "external_ids": {
      "order_group_id": "og_01...",
      "buyer_id": "u_01..."
    }
  },

  "metadata": {
    "any": "arbitrary",
    "json": true
  }
}
````

#### Response

```json
{
  "id": "di_01K...",
  "status": "ADDRESS_PENDING",
  "address": null,
  "expected_amount": "152.34",
  "received_amount": "0",
  "poll_after_ms": 1500
}
```

---

### Get DepositIntent (Polling)

`GET /v1/deposit-intents/{id}`

Returns the latest observed state of the deposit intent.

#### Response

```json
{
  "id": "di_01K...",
  "status": "OBSERVED",
  "address": "TJ9k...abc",
  "expected_amount": "152.34",
  "received_amount": "152.34",

  "min_confirmations": 12,
  "current_confirmations": 9,

  "expires_at": "2026-01-17T15:30:00Z",

  "eligibility": {
    "is_eligible": false,
    "reasons": ["CONFIRMATIONS_PENDING"]
  },

  "reference": {
    "external_ids": {
      "order_group_id": "og_01..."
    }
  },

  "metadata": {
    "any": "arbitrary"
  },

  "poll_after_ms": 2000
}
```

---

### Refresh Deposit Observation (Optional)

`POST /v1/deposit-intents/{id}/refresh`

Queues an asynchronous observation job.
Calling this endpoint multiple times is safe.

#### Response

```json
{
  "id": "di_01K...",
  "queued": true,
  "status": "OBSERVED",
  "poll_after_ms": 1500
}
```

---

## Capture (Critical Section)

### Capture DepositIntent

`POST /v1/deposit-intents/{id}/capture`

Finalizes the deposit **exactly once**.

This endpoint is:

* Idempotent
* Concurrency-safe
* Backed by transactional guarantees

Upstream systems (orders, fulfillment, etc.) must only proceed **after capture**.

#### Request

```json
{
  "idempotency_key": "capture-uuid",
  "expected_amount": "152.34"
}
```

#### Response (first capture or repeated calls)

```json
{
  "id": "di_01K...",
  "status": "CAPTURED",
  "capture": {
    "capture_id": "cap_01K...",
    "captured_at": "2026-01-17T11:33:10Z"
  }
}
```

---

## Concurrency & Safety Guarantees

### At-Most-Once Capture

* Each `DepositIntent` can be captured **once**
* Enforced via:

  * Transactional row locking
  * Unique capture constraints
  * Compare-and-set state transitions

### Idempotency

* `reference.idempotency_key` prevents duplicate intent creation
* Capture requests also require an idempotency key
* Replayed requests return the original response

### Observation Safety

* Deposit observations are repeatable and side-effect free
* Observed amounts are monotonic (never decrease)
* Concurrent observation jobs are safe

---

## Error Handling Philosophy

Errors are expressed as **resource state**, not transport errors.

Example:

```json
{
  "id": "di_01K...",
  "status": "FAILED",
  "failure": {
    "code": "WALLET_PROVIDER_ERROR",
    "message": "Temporary provider failure",
    "retryable": true
  },
  "poll_after_ms": 5000
}
```

Clients continue polling instead of branching on HTTP status codes.

---

## Integration Guidance

* Do **not** create orders on `ELIGIBLE`
* Only create orders after successful `CAPTURE`
* Store `capture_id` upstream to enforce uniqueness
* Treat `reference` and `metadata` as opaque passthrough data

---

## Summary

* `DepositIntent` models payment observation
* `Capture` models irreversible finalization
* Polling is the only client interaction model
* Strong guarantees prevent double processing
* API remains flexible via extensible references
