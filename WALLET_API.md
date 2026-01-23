# WALLET_API.md (Revised to Match `wallet-oas-3.2.0`)

**Polling-Based · Concurrency-Safe · Idempotent · Batch-Oriented Withdrawals**

This document describes the Wallet API as defined by the OpenAPI bundle under `wallet-oas-3.2.0/`, supporting:

* **Deposits** (incoming funds) via `DepositIntent`
* **Withdrawals** (outgoing transfers) via `WithdrawalIntent` (**internally batch-executed**)

The API is designed to prevent:

* double processing
* race conditions
* duplicate wallet executions

Key characteristics:

* **asset-agnostic**
* **internally asynchronous**
* **client-facing polling only** (no webhooks)
* **high-concurrency safe**
* withdrawals are **batch-oriented** internally

---

## 1. Core Design Principles

### 1) Intent-Based Modeling

All monetary actions are modeled as **Intents**:

* `DepositIntent` — expect and later finalize incoming funds
* `WithdrawalIntent` — reserve funds now, send later (internally)

An intent represents a **decision + lifecycle**, not an immediate blockchain action.

---

### 2) Polling-Only Client Interaction

Clients:

* never receive webhooks
* never subscribe to push events
* **only poll resources using `GET`**

State changes are observed via intent resources.

---

### 3) Explicit Finalization & Safety Boundaries

Dangerous, irreversible actions are separated from safe/repeatable ones.

| Operation                       | Safe to repeat | Irreversible |
| ------------------------------- | -------------: | -----------: |
| Observation / refresh (deposit) |              ✅ |            ❌ |
| Capture (deposit)               |              ❌ |            ✅ |
| Wallet transfer (withdrawal)    |              ❌ |            ✅ |

Finalization steps are:

* explicit
* idempotent (where applicable)
* enforced by transactional state transitions

---

### 4) State as Primary Signal (with Practical Exceptions)

Where possible, failures and progress appear in **resource state** (`status`, `failure`, `poll_after_ms`).

However, the current OpenAPI bundle also uses **transport-level `ApiError` responses** for common API concerns such as:

* authentication (`401`)
* not found (`404`)
* idempotency conflict (`409`)
* insufficient balance on withdrawal reserve (`402`)

This document reflects that reality.

---

## 2. Common Concepts

### Reference & Metadata

Most create requests include:

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
  Prevents duplicate intent creation.
  Reusing the same key with a **different payload** must yield **409**.
* `reference.external_ids`
  Opaque upstream identifiers.
* `metadata`
  Arbitrary passthrough data, not interpreted by the wallet.

---

### Amount Encoding

Amounts are **decimal strings**:

* `AmountString`: `'^[0-9]+(\.[0-9]+)?$'`
* Examples: `"0.015"`, `"152.34"`

---

### Failure vs ApiError

* `Failure` object appears **inside intent resources** when `status = FAILED`.
* `ApiError` is used for request/transport semantics (e.g., `401`, `404`, `409`, `402`).

---

## 3. Deposit Pipeline

### 3.1 DepositIntent Lifecycle

A `DepositIntent` represents one expected incoming payment with:

* one receiving address (provisioned async)
* one expected amount
* expiration time
* multiple observations allowed
* **exactly one capture** possible

### 3.2 DepositIntent Statuses

* `CREATED`
* `ADDRESS_PENDING`
* `AWAITING_DEPOSIT`
* `OBSERVED`
* `ELIGIBLE`
* `CAPTURE_PENDING`
* `CAPTURED` (terminal)
* `EXPIRED`
* `CANCELLED`
* `FAILED`

**Important:** `ELIGIBLE` is not final. Only `CAPTURED` is final.

### 3.3 Deposit Endpoints

#### Create DepositIntent

`POST /v1/deposit-intents`

* Creates intent with expected amount and expiry.
* Address provisioning is asynchronous.

#### Get DepositIntent (Polling)

`GET /v1/deposit-intents/{id}`

* Returns current state and server polling hint `poll_after_ms`.

#### Refresh Observation (Safe)

`POST /v1/deposit-intents/{id}/refresh`

* Queues a new observation job.
* Safe to call repeatedly.

#### Capture Deposit (Critical)

`POST /v1/deposit-intents/{id}/capture`

* Finalizes the deposit **exactly once** per intent.
* Uses a dedicated capture idempotency key (`CaptureDepositIntentRequest.idempotency_key`).
* Upstream systems must proceed only after `CAPTURED`.

---

## 4. Withdrawal Pipeline (Batch-Oriented)

### 4.1 WithdrawalIntent: “Reserve now, send later”

A `WithdrawalIntent` represents a user request to withdraw funds.

Key properties (as implemented):

* Funds are **reserved immediately and atomically** on creation.
* Actual wallet transfer is **asynchronous** and **usually executed via internal batching**.
* Each withdrawal is sent **at-most-once**.
* Clients observe state via polling.

### 4.2 WithdrawalIntent Statuses

* `PENDING` — reserved, waiting for batch assignment
* `LOCKED` — assigned to a batch (**irreversible boundary**)
* `SENDING` — wallet call in progress
* `SENT` — txid obtained
* `CONFIRMED` — on-chain confirmed (optional)
* `FAILED` — irrecoverable failure (resource includes `failure`)
* `CANCELLED` — cancelled before batch assignment

**Safety boundary:** `PENDING → LOCKED` is irreversible.
After `LOCKED`, the intent must never be cancelled or reassigned.

### 4.3 Client-visible batching information

The current `WithdrawalIntentBase` includes optional debug-only batching info:

```json
{
  "debug": {
    "batch_id": "string-or-null",
    "batch_status": "CREATED|SENDING|SENT|UNKNOWN|FAILED"
  }
}
```

* `debug` is optional and intended for troubleshooting.
* There are **no standardized scheduling fields** (e.g., `scheduled_for`) in the current schema.

### 4.4 Withdrawal Endpoints

#### Create WithdrawalIntent (Reserve funds)

`POST /v1/withdrawal-intents`

* Auth: user identity comes from bearer token (no `user_id` in body).
* Idempotency: `reference.idempotency_key` prevents duplicate creation.

  * Same key + different payload → **409**
* Responses (as defined):

  * `201` → returns `WithdrawalIntentResponse`
  * `400` → `ApiError` invalid request
  * `401` → `ApiError` unauthorized
  * `402` → `ApiError` insufficient balance / not reservable
  * `409` → `ApiError` idempotency conflict

#### Get WithdrawalIntent (Polling)

`GET /v1/withdrawal-intents/{id}`

* Responses:

  * `200` → `WithdrawalIntentResponse`
  * `401` → `ApiError`
  * `404` → `ApiError`

#### Cancel WithdrawalIntent (PENDING only)

`POST /v1/withdrawal-intents/{id}/cancel`

* Only allowed while `status = PENDING`.
* Reserved funds are released.
* Responses:

  * `200` → `WithdrawalIntentResponse` (typically `CANCELLED`)
  * `401` → `ApiError`
  * `404` → `ApiError`
  * `409` → `ApiError` cannot cancel (not `PENDING`)

---

## 5. Internal: WithdrawalBatch (Non-Public)

Withdrawals are executed via internal batches to guarantee at-most-once sending.

### 5.1 WithdrawalBatch Statuses

* `CREATED` — formed, intents locked
* `SENDING` — wallet call in progress
* `SENT` — txid obtained
* `UNKNOWN` — outcome unclear (requires reconciliation)
* `FAILED` — definitive failure

### 5.2 Invariants

* One intent → one batch only
* One batch → one wallet execution only
* `PENDING` intents are claimed using row locking (e.g., `FOR UPDATE SKIP LOCKED`)
* Wallet uncertainty is isolated via `UNKNOWN` and reconciliation
* Worst-case is **delay**, not duplication

---

## 6. Polling Contract

All intent responses include:

* `poll_after_ms` (server-suggested delay)

Clients should:

* poll `GET` until terminal outcomes are observed:

  * Deposit: `CAPTURED` (or `EXPIRED/CANCELLED/FAILED`)
  * Withdrawal: `SENT/CONFIRMED` (or `CANCELLED/FAILED`)

---

## 7. Integration Rules (Critical)

* Never treat deposit `ELIGIBLE` as finalized; proceed only after `CAPTURED`.
* Never assume withdrawals are sent immediately after creation.
* Never manually retry wallet transfers.
* Never reassign or cancel intents after `LOCKED`.
* Prefer waiting/polling over “creative retries”.

---

## 8. Supporting Endpoints

### Wallet Balance Snapshot

`GET /v1/wallet-balance`

Returns `WalletBalanceResponse` with statuses:

* `OK`, `LOW`, `STALE`, `UNAVAILABLE`, `FAILED`

### Address Validations

`POST /v1/address-validations`

Returns `AddressValidationResponse` with statuses:

* `VALID`, `INVALID`, `UNKNOWN`, `UNAVAILABLE`

---

## 9. Summary

* Intent-based API with strict safety boundaries
* Clients poll only; server handles concurrency and async work
* Deposits: observe → eligible → capture exactly once
* Withdrawals: reserve immediately → batch internally → send at-most-once
* Errors appear either as:

  * intent `failure` (resource-state), or
  * `ApiError` (transport-level) for auth/conflicts/insufficient funds
