// English comments only in code
import express from "express";
import crypto from "crypto";
import { getKnex } from "../db.js";
import { withdrawalQueue } from "../jobs/queue.js";

const router = express.Router();

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
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

function normalizeWithdrawal(row) {
  const reference = safeJson(row.reference, {});
  const metadata = safeJson(row.metadata, {});
  const tx = safeJson(row.tx, null);
  const failure = safeJson(row.failure, null);
  const debug = safeJson(row.debug, null);

  return {
    id: row.id,
    asset: row.asset,
    network: row.network,
    amount: row.amount,
    to_address: row.to_address,
    reference,
    metadata,
    poll_after_ms: 1000,
    debug,

    status: row.status,
    tx,
    failure
  };
}

router.post("/withdrawal-intents", async (req, res) => {
  const knex = getKnex();
  const body = req.body || {};
  const ref = body.reference || {};
  const ikey = ref.idempotency_key;

  if (!ikey) {
    return res.status(400).json({ code: "invalid_request", message: "reference.idempotency_key is required." });
  }

  const fingerprint = sha256Hex(JSON.stringify(body));
  const scope = `withdrawal.create:${req.userId}`;

  const out = await knex.transaction(async (trx) => {
    const existing = await trx("idempotency_keys").where({ scope, ikey }).first();
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { conflict: true };
      const w = await trx("withdrawal_intents").where({ id: existing.resource_id }).first();
      return { w, created: false };
    }

    const id = "wd_" + crypto.randomUUID();
    const now = new Date();

    const w = {
      id,
      user_id: req.userId,
      asset: body.asset,
      network: body.network,
      amount: body.amount,
      to_address: body.to_address,
      status: "PENDING",
      tx: null,
      failure: null,
      debug: JSON.stringify({ batch_id: null, batch_status: "CREATED" }),
      reference: JSON.stringify(body.reference || {}),
      metadata: JSON.stringify(body.metadata || {}),
      created_at: now,
      updated_at: now
    };

    await trx("withdrawal_intents").insert(w);
    await trx("idempotency_keys").insert({
      scope,
      ikey,
      fingerprint,
      resource_type: "withdrawal_intent",
      resource_id: id
    });

    return { w, created: true };
  });

  if (out.conflict) {
    return res.status(409).json({ code: "idempotency_conflict", message: "Same idempotency key used with different payload." });
  }

  await withdrawalQueue.add("withdrawal.pipeline", { withdrawalIntentId: out.w.id }, { jobId: `wd:${out.w.id}:pipeline` });

  return res.status(201).json(normalizeWithdrawal(out.w));
});

router.get("/withdrawal-intents/:id", async (req, res) => {
  const knex = getKnex();
  const w = await knex("withdrawal_intents").where({ id: req.params.id }).first();
  if (!w) return res.status(404).json({ code: "not_found", message: "WithdrawalIntent not found." });
  return res.json(normalizeWithdrawal(w));
});

router.post("/withdrawal-intents/:id/cancel", async (req, res) => {
  const knex = getKnex();
  const id = req.params.id;

  const out = await knex.transaction(async (trx) => {
    const w = await trx("withdrawal_intents").where({ id }).forUpdate().first();
    if (!w) return { notFound: true };
    if (w.status !== "PENDING") return { conflict: true, message: `Cannot cancel in status ${w.status}.` };

    await trx("withdrawal_intents").where({ id, status: "PENDING" }).update({ status: "CANCELLED", updated_at: new Date() });
    const w2 = await trx("withdrawal_intents").where({ id }).first();
    return { w: w2 };
  });

  if (out.notFound) return res.status(404).json({ code: "not_found", message: "WithdrawalIntent not found." });
  if (out.conflict) return res.status(409).json({ code: "cannot_cancel", message: out.message });

  return res.json(normalizeWithdrawal(out.w));
});

export default router;
