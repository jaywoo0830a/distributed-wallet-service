# Wallet API

**Polling-Based · Concurrency-Safe · Idempotent · Batch-Oriented Withdrawals**

This document describes a unified **Wallet API** that supports both
**deposits (incoming payments)** and **withdrawals (outgoing transfers)**.

The system is designed to provide strong guarantees against:

* double processing
* race conditions
* duplicate wallet executions

The API is:

* **asset-agnostic**
* **internally asynchronous**
* **client-facing polling only**
* designed for **high-concurrency and batch-oriented environments**

---

## Core Design Principles

### 1. Intent-Based Modeling

All monetary actions are modeled as **Intents**:

* `DepositIntent` — observe and finalize incoming funds
* `WithdrawalIntent` — reserve funds and later send them out

An intent represents **a financial decision**, not an immediate wallet or
blockchain action.

---

### 2. Polling-Only Client Interaction

Clients:

* never receive webhooks
* never subscribe to push events
* **only poll resources via `GET`**

All state changes are observable via resource state.

---

### 3. Explicit Finalization & Safety Boundaries

Dangerous operations are separated and guarded by state transitions:

| Operation         | Safe to repeat | Irreversible |
| ----------------- | -------------- | ------------ |
| Observation       | ✅ yes          | ❌ no         |
| Capture (deposit) | ❌ no           | ✅ yes        |
| Wallet transfer   | ❌ no           | ✅ yes        |

Finalization steps are always:

* explicit
* idempotent
* concurrency-safe
* enforced by transactional state transitions

---

### 4. State Is the Source of Truth

Errors, progress, delays, and failures are represented as **resource state**,
never as transport-level errors.

Clients react to `status`, not HTTP response codes.

---

## Common Concepts

### Reference & Metadata

Both deposit and withdrawal APIs accept:

```json
{
  "reference": {
    "idempotency_key": "string",
    "external_ids": { "any": "json" }
  },
  "metadata": { "any": "json" }
}
```

* `reference.idempotency_key`
  → prevents duplicate intent creation
* `reference.external_ids`
  → opaque identifiers from upstream systems
* `metadata`
  → arbitrary passthrough data, never interpreted by the wallet

---

## Deposit Pipeline

*(unchanged; omitted here for brevity — semantics remain identical to the
original document)*

---

## Withdrawal Pipeline (Batch-Oriented)

### WithdrawalIntent

A `WithdrawalIntent` represents **a user request to withdraw funds**.

#### Key Characteristics

* Funds are **reserved immediately and atomically**
* Actual wallet transfer is **asynchronous and batch-based**
* Each intent is sent **at most once**
* Clients observe all progress via polling only

---

### Balance Model (Recommended)

Balances are logically split:

| Field               | Meaning                        |
| ------------------- | ------------------------------ |
| `available_balance` | Can be withdrawn               |
| `reserved_balance`  | Locked for pending withdrawals |

This avoids ambiguity during retries, failures, or batching delays.

---

### Batch-Oriented Execution Model (Critical)

Withdrawal intents are **not sent immediately** after creation.

Instead:

1. Funds are reserved at creation time
2. The intent is placed into an internal **withdrawal queue**
3. Intents are **periodically grouped into batches**
4. Each batch triggers **exactly one wallet execution**

Batch scheduling may be:

* hourly
* daily
* or any operator-defined window

From the client’s perspective, batching is observable only via state and
metadata.

---

### WithdrawalIntent States

| Status      | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `PENDING`   | Funds reserved, waiting for batch assignment       |
| `LOCKED`    | Assigned to a batch (irreversible safety boundary) |
| `SENDING`   | Wallet transfer in progress                        |
| `SENT`      | Wallet returned txid                               |
| `CONFIRMED` | On-chain confirmed (optional)                      |
| `FAILED`    | Irrecoverable failure                              |
| `CANCELLED` | Cancelled before batch assignment                  |

> **`PENDING → LOCKED` is an irreversible boundary**
> After `LOCKED`, the intent must never be cancelled or reassigned.

---

### Scheduling Metadata (Client-Visible)

A `WithdrawalIntent` MAY expose the following fields:

```json
{
  "scheduled_for": "2026-01-24T13:00:00Z",
  "batch_window": "HOURLY",
  "next_batch_at": "2026-01-24T13:00:00Z",
  "cancelable_until": "2026-01-24T12:59:59Z"
}
```

* `scheduled_for`
  → earliest time the intent is eligible for batching
* `batch_window`
  → batching strategy (`HOURLY`, `DAILY`, etc.)
* `next_batch_at`
  → server-estimated execution time
* `cancelable_until`
  → last moment cancellation is allowed (`PENDING` only)

These fields are informational and do not affect correctness.

---

### Withdrawal Endpoints

#### Create WithdrawalIntent

`POST /v1/withdrawal-intents`

* reserves funds atomically
* idempotent by `reference.idempotency_key`
* does **not** trigger immediate wallet transfer

#### Get WithdrawalIntent (Polling)

`GET /v1/withdrawal-intents/{id}`

Returns current state, including batching-related metadata.

#### Cancel WithdrawalIntent

`POST /v1/withdrawal-intents/{id}/cancel`

Allowed **only** while `status = PENDING`.

---

## Internal: WithdrawalBatch (Non-Public)

Withdrawals are executed via **internal batches**.

### WithdrawalBatch States

| Status    | Meaning                      |
| --------- | ---------------------------- |
| `CREATED` | Batch formed, intents locked |
| `SENDING` | Wallet call in progress      |
| `SENT`    | Wallet returned txid         |
| `UNKNOWN` | Wallet outcome unclear       |
| `FAILED`  | Definitive failure           |

---

### Batch Invariants (Critical)

* One intent → one batch only
* One batch → one wallet execution only
* Wallet calls must be idempotent or externally reconcilable
* Batches must use **deterministic idempotency keys**
* Uncertainty is isolated (`UNKNOWN` + reconciliation)

---

## Concurrency & Idempotency Guarantees

### Withdrawal

* Balance reservation is atomic
* `PENDING` intents are claimed using
  `FOR UPDATE SKIP LOCKED`
* Batch assignment transitions intents to `LOCKED`
* Wallet execution happens **once per batch**
* Worst-case outcome is delay, never duplication

---

## Error Representation

Errors are represented as part of resource state:

```json
{
  "id": "intent_id",
  "status": "FAILED",
  "failure": {
    "code": "WALLET_TIMEOUT",
    "message": "Wallet provider did not respond",
    "retryable": false
  },
  "poll_after_ms": 5000
}
```

Clients **continue polling** regardless of errors.

---

## Integration Rules (Critical)

* Never assume immediate withdrawal execution
* Never retry wallet transfers manually
* Never reassign `LOCKED` withdrawal intents
* Treat wallet operations as irreversible
* Delays are acceptable; duplication is not

---

## Summary

* Deposits and withdrawals share an intent-based model
* Withdrawals are **reserved immediately, executed in batches**
* Clients observe state via polling only
* Safety boundaries are explicit and enforced
* Correctness is always prioritized over speed
