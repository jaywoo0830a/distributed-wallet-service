# Wallet API

**Polling-Based · Concurrency-Safe · Idempotent**

This document describes a unified **Wallet API** that supports both **deposits**
(incoming payments) and **withdrawals** (outgoing transfers) with strong
guarantees against:

* double processing
* race conditions
* duplicate wallet executions

The API is:

* **asset-agnostic**
* **internally asynchronous**
* **client-facing polling only**
* designed for **high-concurrency environments**

---

## Core Design Principles

### 1. Intent-Based Modeling

All monetary actions are modeled as **Intents**:

* `DepositIntent` — observe and finalize incoming funds
* `WithdrawalIntent` — reserve funds and later send them out

An intent represents **a decision**, not an immediate blockchain action.

---

### 2. Polling-Only Client Interaction

Clients:

* never receive webhooks
* never subscribe to push events
* **only poll resources**

All state changes are observable via `GET`.

---

### 3. Explicit Finalization

Dangerous operations are separated:

| Operation             | Safe to repeat | Irreversible |
| --------------------- | -------------- | ------------ |
| Observation           | ✅ yes          | ❌ no         |
| Capture (deposit)     | ❌ no           | ✅ yes        |
| Transfer (withdrawal) | ❌ no           | ✅ yes        |

Finalization is always:

* explicit
* idempotent
* guarded by transactional state transitions

---

### 4. State Is the Source of Truth

Errors, progress, and failures are represented as **resource state**, not
transport-level errors.

Clients react to `status`, not HTTP codes.

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

### DepositIntent

A `DepositIntent` represents **one expected incoming payment**.

#### Characteristics

* One receiving address
* One expected amount
* One expiration window
* Multiple observations
* **Exactly one possible capture**

---

### DepositIntent States

| Status             | Meaning                                    |
| ------------------ | ------------------------------------------ |
| `CREATED`          | Intent created                             |
| `ADDRESS_PENDING`  | Address creation queued                    |
| `AWAITING_DEPOSIT` | Address ready, waiting for funds           |
| `OBSERVED`         | Funds detected / confirmations progressing |
| `ELIGIBLE`         | Deposit satisfies all conditions           |
| `CAPTURE_PENDING`  | Capture attempt in progress                |
| `CAPTURED`         | Finalized (terminal)                       |
| `EXPIRED`          | Expired without capture                    |
| `CANCELLED`        | Cancelled by upstream                      |
| `FAILED`           | Internal failure                           |

> `ELIGIBLE` ≠ finalized
> **Only `CAPTURED` is terminal and at-most-once**

---

### Deposit Endpoints

#### Create DepositIntent

`POST /v1/deposit-intents`

Creates an intent. Address provisioning is asynchronous.

#### Get DepositIntent (Polling)

`GET /v1/deposit-intents/{id}`

Returns latest observed state.

#### Refresh Observation (Optional)

`POST /v1/deposit-intents/{id}/refresh`

Queues a new observation job. Safe to call repeatedly.

---

### Capture (Critical Section)

#### Capture Deposit

`POST /v1/deposit-intents/{id}/capture`

Finalizes the deposit **exactly once**.

Properties:

* idempotent
* concurrency-safe
* transactionally enforced

Upstream systems **must only proceed after CAPTURED**.

---

## Withdrawal Pipeline

### WithdrawalIntent

A `WithdrawalIntent` represents **a user request to withdraw funds**.

#### Characteristics

* Funds are **reserved immediately**
* Actual wallet transfer is asynchronous
* Each intent is sent **at most once**
* Clients observe state via polling only

---

### Balance Model (Recommended)

Balances are logically split:

| Field               | Meaning                        |
| ------------------- | ------------------------------ |
| `available_balance` | Can be withdrawn               |
| `reserved_balance`  | Locked for pending withdrawals |

This avoids ambiguity during failures and retries.

---

### WithdrawalIntent States

| Status      | Meaning                          |
| ----------- | -------------------------------- |
| `PENDING`   | Request accepted, funds reserved |
| `LOCKED`    | Assigned to a batch              |
| `SENDING`   | Wallet transfer in progress      |
| `SENT`      | Wallet returned txid             |
| `CONFIRMED` | On-chain confirmed (optional)    |
| `FAILED`    | Irrecoverable failure            |
| `CANCELLED` | Cancelled before batching        |

> `PENDING → LOCKED` is an irreversible safety boundary.

---

### Withdrawal Endpoints

#### Create WithdrawalIntent

`POST /v1/withdrawal-intents`

* reserves funds atomically
* idempotent by `reference.idempotency_key`

#### Get WithdrawalIntent (Polling)

`GET /v1/withdrawal-intents/{id}`

#### Cancel WithdrawalIntent

`POST /v1/withdrawal-intents/{id}/cancel`

Allowed **only** in `PENDING`.

---

## Internal: WithdrawalBatch (Non-Public)

Withdrawals are executed via **batches** to guarantee safety.

### WithdrawalBatch States

| Status    | Meaning                 |
| --------- | ----------------------- |
| `CREATED` | Batch formed            |
| `SENDING` | Wallet call in progress |
| `SENT`    | txid obtained           |
| `UNKNOWN` | Wallet outcome unclear  |
| `FAILED`  | Definitive failure      |

### Invariants

* One intent → one batch only
* One batch → one wallet execution only
* Wallet calls must be idempotent or externally reconcilable

---

## Concurrency & Idempotency Guarantees

### Deposit

* Capture enforced once via:

  * row locking
  * unique capture constraint
  * compare-and-set transitions

### Withdrawal

* Balance reservation is atomic
* `PENDING` intents are claimed via locking (`FOR UPDATE SKIP LOCKED`)
* Batches use deterministic idempotency keys
* Wallet uncertainty is isolated (`UNKNOWN` + reconciliation)

---

## Error Representation

Errors are part of resource state:

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

Clients **continue polling**.

---

## Integration Rules (Critical)

* Never create orders on `ELIGIBLE`
* Only proceed after `CAPTURED`
* Never retry wallet transfers manually
* Never reassign locked withdrawal intents
* Treat wallet operations as irreversible

---

## Summary

* Deposits and withdrawals share a single intent-based philosophy
* Clients only poll; servers manage concurrency
* Finalization is explicit and idempotent
* Worst-case outcome is **delay**, never duplication
* Correctness is always prioritized over speed

---

## OpenAPI Mapping (Guidance)

This design maps cleanly to **OpenAPI 3.0**:

* `DepositIntent`, `WithdrawalIntent` → `schemas`
* State enums → `enum`
* Polling endpoints → `GET`
* Finalization endpoints (`capture`, `cancel`) → `POST` with idempotency keys
* Errors → part of response schema, not HTTP error branches
