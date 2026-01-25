import express from "express";
import { DataSource } from "typeorm";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import Decimal from "decimal.js";
import { body, validationResult } from "express-validator";

// Import schemas with explicit extension for ESM
import {
  DepositIntentSchema,
  WithdrawalIntentSchema,
  WithdrawalBatchSchema,
} from "./schemas.js";

// --- 1. Wallet Adapter (Mock Implementation) ---
class MockWalletAdapter {
  async createAddress(asset, network) {
    return `mock_addr_${network}_${uuidv4().substring(0, 8)}`;
  }

  async sendBatch(withdrawals, asset, network) {
    console.log(
      `[Adapter] Processing batch of ${withdrawals.length} items for ${asset}/${network}...`,
    );
    await new Promise((r) => setTimeout(r, 1000)); // Simulate latency
    return `tx_${uuidv4()}`;
  }

  async getBalance(asset, network) {
    return { total: "50000.00", spendable: "45000.00" };
  }
}
const walletAdapter = new MockWalletAdapter();

// --- 2. Configuration & Connections ---
const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
};

let AppDataSource;
let redisConnection;
let provisionQueue;
let batchQueue;

// Retry logic for robust DB connection
const connectDB = async (retries = 15) => {
  const dataSource = new DataSource({
    type: "mysql",
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    username: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    database: process.env.DB_NAME || "wallet_service",
    entities: [
      DepositIntentSchema,
      WithdrawalIntentSchema,
      WithdrawalBatchSchema,
    ],
    synchronize: true, // Only for dev/demo. Use migrations for prod.
    logging: false,
  });

  while (retries) {
    try {
      await dataSource.initialize();
      console.log("Database connected successfully.");
      return dataSource;
    } catch (err) {
      console.error(
        `DB Connection Failed. Retries left: ${retries}. Waiting...`,
      );
      retries -= 1;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  throw new Error("Could not connect to database.");
};

// --- 3. Workers (Background Jobs) ---
const startWorkers = () => {
  // Worker 1: Provision Deposit Address
  new Worker(
    "provision-address",
    async (job) => {
      const { intentId } = job.data;
      const repo = AppDataSource.getRepository(DepositIntentSchema);
      const intent = await repo.findOneBy({ id: intentId });

      if (!intent || intent.status !== "ADDRESS_PENDING") return;

      try {
        const address = await walletAdapter.createAddress(
          intent.asset,
          intent.network,
        );
        await repo.update(intentId, { address, status: "AWAITING_DEPOSIT" });
        console.log(`[Worker] Address assigned for Intent ${intentId}`);
      } catch (e) {
        console.error(`[Worker] Address provision failed: ${e.message}`);
      }
    },
    { connection: redisConnection },
  );

  // Worker 2: Withdrawal Batch Processing
  new Worker(
    "withdrawal-batching",
    async (job) => {
      const { asset, network } = job.data;
      const queryRunner = AppDataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction(); // Default isolation or SERIALIZABLE if strict safety needed

      try {
        // Find PENDING intents and lock rows (Pessimistic Write)
        const pending = await queryRunner.manager.find(WithdrawalIntentSchema, {
          where: { status: "PENDING", asset, network },
          lock: { mode: "pessimistic_write" },
        });

        if (pending.length === 0) {
          await queryRunner.rollbackTransaction();
          return;
        }

        // Create Batch Record
        const batchRepo = queryRunner.manager.getRepository(
          WithdrawalBatchSchema,
        );
        const batch = batchRepo.create({ status: "CREATED", asset, network });
        const savedBatch = await batchRepo.save(batch);

        // Lock intents to this batch
        for (const item of pending) {
          item.status = "LOCKED";
          item.batchId = savedBatch.id;
          await queryRunner.manager.save(WithdrawalIntentSchema, item);
        }

        await queryRunner.commitTransaction();

        // Execute Wallet Transfer (Broadcast)
        try {
          await AppDataSource.getRepository(WithdrawalBatchSchema).update(
            savedBatch.id,
            { status: "SENDING" },
          );

          const txid = await walletAdapter.sendBatch(
            pending.map((p) => ({ to: p.toAddress, amount: p.amount })),
            asset,
            network,
          );

          // Update final status
          await AppDataSource.getRepository(WithdrawalBatchSchema).update(
            savedBatch.id,
            { status: "SENT", txid },
          );
          await AppDataSource.getRepository(WithdrawalIntentSchema).update(
            pending.map((p) => p.id),
            { status: "SENT", txid },
          );
          console.log(`[Worker] Batch ${savedBatch.id} sent via TX: ${txid}`);
        } catch (err) {
          console.error("Batch send failed", err);
          await AppDataSource.getRepository(WithdrawalBatchSchema).update(
            savedBatch.id,
            { status: "FAILED" },
          );
          // Intents remain LOCKED/FAILED requiring manual intervention or retry logic
        }
      } catch (err) {
        if (queryRunner.isTransactionActive)
          await queryRunner.rollbackTransaction();
        console.error("Batch worker transaction error", err);
      } finally {
        await queryRunner.release();
      }
    },
    { connection: redisConnection },
  );
};

// --- 4. API Server ---
const app = express();
app.use(express.json());

const validateBase = [
  body("asset").notEmpty(),
  body("network").notEmpty(),
  body("reference.idempotency_key").notEmpty(),
];

// POST /v1/deposit-intents
app.post("/v1/deposit-intents", validateBase, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { asset, network, expected_amount, expires_at, reference, metadata } =
    req.body;
  const repo = AppDataSource.getRepository(DepositIntentSchema);

  // Idempotency Check
  const existing = await repo.findOneBy({
    idempotencyKey: reference.idempotency_key,
  });
  if (existing) return res.status(201).json(existing);

  const intent = repo.create({
    status: "ADDRESS_PENDING",
    asset,
    network,
    expectedAmount: expected_amount,
    expiresAt: new Date(expires_at),
    idempotencyKey: reference.idempotency_key,
    metadata,
  });

  try {
    const saved = await repo.save(intent);
    await provisionQueue.add(`provision-${saved.id}`, { intentId: saved.id });
    res.status(201).json(saved);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return res
        .status(409)
        .json({ code: "CONFLICT", message: "Idempotency key exists" });
    res.status(500).json({ error: e.message });
  }
});

// GET /v1/deposit-intents/:id
app.get("/v1/deposit-intents/:id", async (req, res) => {
  const intent = await AppDataSource.getRepository(
    DepositIntentSchema,
  ).findOneBy({ id: req.params.id });
  if (!intent) return res.status(404).json({ code: "NOT_FOUND" });
  res.json({ ...intent, poll_after_ms: 3000 });
});

// POST /v1/withdrawal-intents
app.post(
  "/v1/withdrawal-intents",
  [
    ...validateBase,
    body("amount").custom((val) => new Decimal(val).gt(0)),
    body("to_address").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { asset, network, amount, to_address, reference } = req.body;
    const repo = AppDataSource.getRepository(WithdrawalIntentSchema);

    // Idempotency Check
    const existing = await repo.findOneBy({
      idempotencyKey: reference.idempotency_key,
    });
    if (existing) return res.status(201).json(existing);

    // Balance Check
    const balance = await walletAdapter.getBalance(asset, network);
    if (new Decimal(balance.spendable).lessThan(amount)) {
      return res.status(402).json({ code: "INSUFFICIENT_FUNDS" });
    }

    const intent = repo.create({
      status: "PENDING",
      asset,
      network,
      amount,
      toAddress: to_address,
      idempotencyKey: reference.idempotency_key,
    });

    try {
      const saved = await repo.save(intent);
      res.status(201).json(saved);
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY")
        return res.status(409).json({ code: "CONFLICT" });
      res.status(500).json({ error: e.message });
    }
  },
);

// GET /v1/wallet-balance
app.get("/v1/wallet-balance", async (req, res) => {
  const { asset, network } = req.query;
  const balance = await walletAdapter.getBalance(asset, network);
  res.json({ asset, network, status: "OK", ...balance });
});

// --- Bootstrapping ---
const start = async () => {
  try {
    AppDataSource = await connectDB();

    redisConnection = new Redis(redisConfig);
    provisionQueue = new Queue("provision-address", {
      connection: redisConnection,
    });
    batchQueue = new Queue("withdrawal-batching", {
      connection: redisConnection,
    });

    startWorkers();

    // Schedule periodic batches (e.g., every 60 seconds for USDT/TRON)
    await batchQueue.add(
      `batch-USDT-TRON`,
      { asset: "USDT", network: "TRON" },
      {
        repeat: { every: 60 * 1000 },
        jobId: `cron-USDT-TRON`,
      },
    );
    console.log("Scheduler registered: USDT/TRON batching every 60s.");

    app.listen(3000, () =>
      console.log("Service running at http://localhost:3000"),
    );
  } catch (e) {
    console.error("Bootstrap Error:", e);
    process.exit(1);
  }
};

start();
