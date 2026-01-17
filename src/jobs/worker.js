// English comments only in code
import { Worker } from "bullmq";
import { redisConn } from "./queue.js";
import { getKnex } from "../db.js";
import { WalletAdapter } from "../wallet/adapter.js";

const wallet = new WalletAdapter();

async function acquireJobLock(knex, jobKey) {
  try {
    await knex("job_locks").insert({ job_key: jobKey });
    return true;
  } catch {
    return false;
  }
}

new Worker(
  "deposit",
  async (job) => {
    const knex = getKnex();
    const { depositIntentId } = job.data;

    const lockOk = await acquireJobLock(knex, `deposit:${job.name}:${depositIntentId}`);
    if (!lockOk) return;

    if (job.name === "deposit.provision_and_observe") {
      await knex.transaction(async (trx) => {
        const d = await trx("deposit_intents").where({ id: depositIntentId }).forUpdate().first();
        if (!d) return;
        if (["CAPTURED", "CANCELLED", "FAILED", "EXPIRED"].includes(d.status)) return;
        if (!d.address) {
          await trx("deposit_intents").where({ id: depositIntentId }).update({ status: "ADDRESS_PENDING", updated_at: new Date() });
        }
      });

      const d0 = await knex("deposit_intents").where({ id: depositIntentId }).first();
      if (!d0) return;
      if (!d0.address) {
        const { address } = await wallet.provisionDepositAddress({
          depositIntentId,
          asset: d0.asset,
          network: d0.network,
          userId: d0.user_id
        });

        await knex("deposit_intents").where({ id: depositIntentId }).update({
          address,
          status: "AWAITING_DEPOSIT",
          eligibility: JSON.stringify({ is_eligible: false, reasons: ["awaiting_deposit"] }),
          updated_at: new Date()
        });
      }

      await job.queue.add("deposit.refresh", { depositIntentId }, { jobId: `dep:${depositIntentId}:auto-refresh` });
      return;
    }

    if (job.name === "deposit.refresh") {
      const d = await knex("deposit_intents").where({ id: depositIntentId }).first();
      if (!d || !d.address) return;
      if (["CAPTURED", "CANCELLED", "FAILED", "EXPIRED"].includes(d.status)) return;

      const obs = await wallet.observeDeposit({
        address: d.address,
        asset: d.asset,
        network: d.network,
        minConfirmations: d.min_confirmations
      });

      const received = obs.received_amount;
      const conf = Number(obs.current_confirmations || 0);

      let status = d.status;
      let eligibility = d.eligibility ? JSON.parse(d.eligibility) : null;

      if (received !== "0") {
        status = "OBSERVED";
        const ok = conf >= d.min_confirmations;
        eligibility = { is_eligible: ok, reasons: ok ? [] : ["not_enough_confirmations"] };
        if (ok) status = "ELIGIBLE";
      }

      await knex("deposit_intents").where({ id: depositIntentId }).update({
        received_amount: received,
        current_confirmations: conf,
        status,
        eligibility: eligibility ? JSON.stringify(eligibility) : null,
        updated_at: new Date()
      });

      return;
    }

    if (job.name === "deposit.capture") {
      const d = await knex.transaction(async (trx) => {
        const row = await trx("deposit_intents").where({ id: depositIntentId }).forUpdate().first();
        if (!row) return null;
        if (row.status !== "CAPTURE_PENDING") return null;
        return row;
      });

      if (!d) return;

      const cap = await wallet.captureDeposit({
        depositIntentId,
        asset: d.asset,
        network: d.network,
        amount: d.expected_amount,
        userId: d.user_id
      });

      await knex("deposit_intents").where({ id: depositIntentId }).update({
        status: "CAPTURED",
        capture: JSON.stringify(cap),
        updated_at: new Date()
      });

      return;
    }
  },
  redisConn()
);

new Worker(
  "withdrawal",
  async (job) => {
    const knex = getKnex();
    const { withdrawalIntentId } = job.data;

    const lockOk = await acquireJobLock(knex, `withdrawal:${job.name}:${withdrawalIntentId}`);
    if (!lockOk) return;

    if (job.name === "withdrawal.pipeline") {
      const w = await knex.transaction(async (trx) => {
        const row = await trx("withdrawal_intents").where({ id: withdrawalIntentId }).forUpdate().first();
        if (!row) return null;
        if (["CANCELLED", "FAILED", "CONFIRMED"].includes(row.status)) return null;
        if (row.status !== "PENDING") return null;

        await trx("withdrawal_intents").where({ id: withdrawalIntentId, status: "PENDING" }).update({
          status: "LOCKED",
          updated_at: new Date(),
          debug: JSON.stringify({ batch_id: null, batch_status: "CREATED" })
        });

        return await trx("withdrawal_intents").where({ id: withdrawalIntentId }).first();
      });

      if (!w) return;

      await wallet.reserveWithdrawal({
        withdrawalIntentId,
        asset: w.asset,
        network: w.network,
        amount: w.amount,
        userId: w.user_id
      });

      await knex("withdrawal_intents").where({ id: withdrawalIntentId }).update({ status: "SENDING", updated_at: new Date() });

      const tx = await wallet.sendWithdrawal({
        withdrawalIntentId,
        asset: w.asset,
        network: w.network,
        amount: w.amount,
        to_address: w.to_address,
        userId: w.user_id
      });

      await knex("withdrawal_intents").where({ id: withdrawalIntentId }).update({
        status: "SENT",
        tx: JSON.stringify(tx),
        debug: JSON.stringify({ batch_id: null, batch_status: "SENT" }),
        updated_at: new Date()
      });

      return;
    }
  },
  redisConn()
);
