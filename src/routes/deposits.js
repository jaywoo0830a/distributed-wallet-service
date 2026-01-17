// English comments only in code
import express from "express";
import crypto from "crypto";
import { getKnex } from "../db.js";
import { depositQueue } from "../jobs/queue.js";

const router = express.Router();

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function pollAfterMs(status) {
  switch (status) {
    case "CREATED":
    case "ADDRESS_PENDING":
      return 800;
    case "AWAITING_DEPOSIT":
    case "OBSERVED":
      return 1200;
    case "ELIGIBLE":
    case "CAPTURE_PENDING":
      return 600;
    default:
      return 1500;
  }
}

function safeJson(v, fallback) {
  try {
    if (v === null || v === undefined) return fallback;
    if (typeof v === "object") return v;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function normalizeDeposit(row) {
  const reference = safeJson(row.reference, {});
  const metadata = safeJson(row.metadata, {});
  const eligibility = safeJson(row.eligibility, null);
  const capture = safeJson(row.capture, null);
  const failure = safeJson(row.failure, null);

  return {
    id: row.id,
    asset: row.asset,
    network: row.network,
    expected_amount: row.expected_amount,
    received_amount: row.received_amount,
    min_confirmations: row.min_confirmations,
    current_confirmations: row.current_confirmations,
    expires_at: new Date(row.expires_at).toISOString(),
    reference,
    metadata,
    poll_after_ms: pollAfterMs(row.status),

    status: row.status,
    address: row.address ?? null,
    eligibility,
    capture,
    failure
  };
}

router.post("/deposit-intents", async (req, res) => {
  const knex = getKnex();
  const body = req.body || {};
  const ref = body.reference || {};
  const ikey = ref.idempotency_key;

  if (!ikey) {
    return res.status(400).json({ code: "invalid_request", message: "reference.idempotency_key is required." });
  }

  const fingerprint = sha256Hex(JSON.stringify(body));
  const scope = "deposit.create";

  const result = await knex.transaction(async (trx) => {
    const existing = await trx("idempotency_keys").where({ scope, ikey }).first();

    if (existing) {
      if (existing.fingerprint !== fingerprint) return { conflict: true };
      const d = await trx("deposit_intents").where({ id: existing.resource_id }).first();
      return { deposit: d, created: false };
    }

    const id = "dep_" + crypto.randomUUID();
    const now = new Date();

    const deposit = {
      id,
      user_id: req.userId,
      asset: body.asset,
      network: body.network,
      expected_amount: body.expected_amount,
      received_amount: "0",
      min_confirmations: Number(body?.policy?.min_confirmations ?? 0) || 0,
      current_confirmations: 0,
      status: "CREATED",
      address: null,
      eligibility: null,
      capture: null,
      failure: null,
      reference: JSON.stringify(body.reference || {}),
      metadata: JSON.stringify(body.metadata || {}),
      expires_at: body.expires_at,
      created_at: now,
      updated_at: now
    };

    await trx("deposit_intents").insert(deposit);

    await trx("idempotency_keys").insert({
      scope,
      ikey,
      fingerprint,
      resource_type: "deposit_intent",
      resource_id: id
    });

    return { deposit, created: true };
  });

  if (result.conflict) {
    return res.status(409).json({
      code: "idempotency_conflict",
      message: "Same idempotency key used with different payload."
    });
  }

  await depositQueue.add(
    "deposit.provision_and_observe",
    { depositIntentId: result.deposit.id },
    { jobId: `dep:${result.deposit.id}:pipeline` }
  );

  return res.status(201).json(normalizeDeposit(result.deposit));
});

router.get("/deposit-intents/:id", async (req, res) => {
  const knex = getKnex();
  const d = await knex("deposit_intents").where({ id: req.params.id }).first();
  if (!d) return res.status(404).json({ code: "not_found", message: "DepositIntent not found." });
  return res.json(normalizeDeposit(d));
});

router.post("/deposit-intents/:id/refresh", async (req, res) => {
  const knex = getKnex();
  const d = await knex("deposit_intents").where({ id: req.params.id }).first();
  if (!d) return res.status(404).json({ code: "not_found", message: "DepositIntent not found." });

  await depositQueue.add(
    "deposit.refresh",
    { depositIntentId: d.id },
    { jobId: `dep:${d.id}:refresh:${Date.now()}` }
  );

  return res.status(202).json({ id: d.id, queued: true, status: d.status, poll_after_ms: 500 });
});

router.post("/deposit-intents/:id/capture", async (req, res) => {
  const knex = getKnex();
  const { idempotency_key, expected_amount } = req.body || {};

  if (!idempotency_key) {
    return res.status(400).json({ code: "invalid_request", message: "idempotency_key is required." });
  }
  if (!expected_amount) {
    return res.status(400).json({ code: "invalid_request", message: "expected_amount is required." });
  }

  const depositId = req.params.id;
  const fingerprint = sha256Hex(JSON.stringify({ idempotency_key, expected_amount }));

  const out = await knex.transaction(async (trx) => {
    const cap = await trx("deposit_captures")
      .where({ deposit_intent_id: depositId, ikey: idempotency_key })
      .first();

    if (cap) {
      if (cap.fingerprint !== fingerprint) return { conflict: true };
      return { snapshot: safeJson(cap.result_snapshot, {}) };
    }

    const d = await trx("deposit_intents").where({ id: depositId }).forUpdate().first();
    if (!d) return { notFound: true };

    if (d.expected_amount !== expected_amount) {
      return { conflict: true, message: "expected_amount does not match intent." };
    }

    if (d.status === "CAPTURED") {
      const snap = normalizeDeposit(d);
      await trx("deposit_captures").insert({
        deposit_intent_id: depositId,
        ikey: idempotency_key,
        fingerprint,
        result_snapshot: JSON.stringify(snap)
      });
      return { snapshot: snap };
    }

    if (d.status !== "ELIGIBLE") {
      return { conflict: true, message: `Cannot capture in status ${d.status}. Must be ELIGIBLE.` };
    }

    await trx("deposit_intents")
      .where({ id: depositId, status: "ELIGIBLE" })
      .update({ status: "CAPTURE_PENDING", updated_at: new Date() });

    const d2 = await trx("deposit_intents").where({ id: depositId }).first();
    const snap = normalizeDeposit(d2);

    await trx("deposit_captures").insert({
      deposit_intent_id: depositId,
      ikey: idempotency_key,
      fingerprint,
      result_snapshot: JSON.stringify(snap)
    });

    return { snapshot: snap, enqueueCapture: true };
  });

  if (out.notFound) return res.status(404).json({ code: "not_found", message: "DepositIntent not found." });
  if (out.conflict) {
    return res.status(409).json({ code: "capture_conflict", message: out.message || "Incompatible capture replay." });
  }

  if (out.enqueueCapture) {
    await depositQueue.add("deposit.capture", { depositIntentId: depositId }, { jobId: `dep:${depositId}:capture` });
  }

  return res.json(out.snapshot);
});

export default router;
