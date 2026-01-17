# Withdrawal Pipeline API (Concurrency-Safe, Idempotent)

This document describes a **safe, idempotent withdrawal pipeline** designed to
prevent double spending, duplicate transfers, and race conditions in
high-concurrency environments.

The API is **polling-based for clients** and **asynchronous internally**.
Actual wallet transfers are executed in **batch units** and are guaranteed
to occur **at most once**.

---

## Core Concepts

### WithdrawalIntent

A `WithdrawalIntent` represents a **user’s request to withdraw funds**.

Key properties:

- Funds are **reserved immediately** at request time
- Actual wallet transfer happens later, asynchronously
- Each intent can be sent **at most once**
- Clients only observe state via polling

### WithdrawalBatch

A `WithdrawalBatch` is an **internal aggregation unit** used to:

- Group multiple pending withdrawals
- Send them via a single `transferMany` call
- Enforce at-most-once wallet execution

`WithdrawalBatch` is typically **not exposed** to clients but is critical for
safety and correctness.

---

## Design Goals

- Prevent double withdrawals under any circumstances
- Ensure balance correctness under concurrent requests
- Support safe retries and worker restarts
- Isolate wallet uncertainty (timeouts, partial failures)
- Avoid coupling to specific business or e-commerce schemas

---

## Balance Model (Recommended)

Instead of directly subtracting from a single balance field, balances are
logically split:

- `available_balance` — usable for new withdrawal requests
- `reserved_balance` — locked for pending withdrawals

### On Withdrawal Request

- `available_balance -= amount`
- `reserved_balance += amount`

### On Successful Transfer

- `reserved_balance -= amount`

### On Cancellation or Failure

- `reserved_balance -= amount`
- `available_balance += amount`

This model makes pending obligations explicit and safe.

---

## WithdrawalIntent State Model

| Status | Meaning |
|------|--------|
| `PENDING` | Request accepted, funds reserved |
| `LOCKED` | Assigned to a batch (cannot be reassigned) |
| `SENDING` | Batch is attempting wallet transfer |
| `SENT` | Wallet returned a transaction ID |
| `CONFIRMED` | On-chain confirmation complete (optional) |
| `FAILED` | Irrecoverable internal failure |
| `CANCELLED` | Cancelled before batch assignment |

### Critical Boundary

Once an intent transitions from `PENDING` → `LOCKED`,
it **must never** be included in another batch.

---

## API Endpoints

### Create WithdrawalIntent

`POST /v1/withdrawal-intents`

Creates a new withdrawal request and **reserves funds atomically**.

#### Request

```json
{
  "asset": "USDT",
  "network": "TRON",
  "amount": "25.00",
  "to_address": "TJ9k...abc",

  "reference": {
    "idempotency_key": "uuid-or-hash",
    "external_ids": {
      "user_id": "u_01...",
      "request_id": "withdraw-123"
    }
  },

  "metadata": {
    "note": "optional"
  }
}
````

#### Response

```json
{
  "id": "wi_01K...",
  "status": "PENDING",
  "amount": "25.00",
  "to_address": "TJ9k...abc",
  "poll_after_ms": 1500
}
```

### Guarantees

* `reference.idempotency_key` prevents duplicate creation
* Balance reservation is atomic and concurrency-safe
* Insufficient balance results in request rejection

---

### Get WithdrawalIntent (Polling)

`GET /v1/withdrawal-intents/{id}`

Returns the latest known state of the withdrawal.

#### Response

```json
{
  "id": "wi_01K...",
  "status": "SENT",
  "amount": "25.00",
  "to_address": "TJ9k...abc",

  "tx": {
    "txid": "0xabc...",
    "sent_at": "2026-01-17T12:10:00Z"
  },

  "failure": null,

  "reference": {
    "external_ids": {
      "request_id": "withdraw-123"
    }
  },

  "metadata": {
    "note": "optional"
  },

  "poll_after_ms": 3000
}
```

---

### Cancel WithdrawalIntent

`POST /v1/withdrawal-intents/{id}/cancel`

Cancels a withdrawal **only if it has not been assigned to a batch**.

#### Allowed Status

* `PENDING` only

#### Effects

* Reserved funds are released
* Status becomes `CANCELLED`

#### Response

```json
{
  "id": "wi_01K...",
  "status": "CANCELLED",
  "poll_after_ms": 0
}
```

---

## Internal: WithdrawalBatch Lifecycle

### WithdrawalBatch States

| Status    | Meaning                         |
| --------- | ------------------------------- |
| `CREATED` | Batch created, intents assigned |
| `SENDING` | Wallet transfer in progress     |
| `SENT`    | Wallet returned transaction ID  |
| `UNKNOWN` | Wallet response uncertain       |
| `FAILED`  | Transfer definitively failed    |

### Critical Invariants

* A `WithdrawalIntent` can belong to **only one batch**
* A batch can be sent **only once**
* Wallet transfer must be idempotent or externally verifiable

---

## Worker Algorithm (Concurrency-Safe)

### 1. Batch Assignment (`PENDING → LOCKED`)

* Begin DB transaction
* Select eligible `PENDING` intents using row locking
  (`FOR UPDATE SKIP LOCKED` or CAS update)
* Assign them a new `batch_id`
* Update status to `LOCKED`
* Create batch record
* Commit

> This step guarantees that no two workers can select the same intent.

---

### 2. Wallet Transfer (`CREATED → SENT`)

* Transition batch to `SENDING` via CAS
* Call `transferMany` with:

  * deterministic idempotency key / nonce
* On success:

  * store `txid`
  * mark batch `SENT`
  * mark intents `SENT`

---

## Handling Wallet Uncertainty

### Timeout / Unknown Outcome

If the wallet call times out or returns an ambiguous result:

1. Mark batch as `UNKNOWN`
2. **Do not retry immediately**
3. Run a reconciliation process:

   * Query wallet / chain for transfer existence
   * If found → mark `SENT`
   * If proven absent → allow controlled retry

This prevents accidental double sending.

---

## Idempotency & Safety Guarantees

### WithdrawalIntent Creation

* Protected by `reference.idempotency_key`
* Duplicate requests return original intent

### Batch Execution

* Each batch has a unique idempotency key / nonce
* Wallet transfers are executed at most once

### State Transitions

* All critical transitions use compare-and-set semantics
* Illegal transitions are rejected

---

## Error Representation

Errors are expressed as **resource state**, not transport errors.

```json
{
  "id": "wi_01K...",
  "status": "FAILED",
  "failure": {
    "code": "WALLET_TIMEOUT",
    "message": "Wallet provider did not respond",
    "retryable": false
  },
  "poll_after_ms": 5000
}
```

Clients continue polling instead of branching on HTTP status codes.

---

## Integration Rules (Important)

* Do not assume `PENDING` implies imminent transfer
* Do not retry wallet transfers manually
* Do not reassign intents once `LOCKED`
* Always treat wallet operations as non-reversible

---

## Summary

* Withdrawal requests reserve funds immediately
* Actual transfers occur asynchronously in batches
* Each withdrawal is sent at most once
* Concurrency and retries are explicitly controlled
* Wallet uncertainty is isolated and reconciled safely

This design prioritizes **correctness over speed** and ensures that
the worst-case outcome is delay — never double withdrawal.
