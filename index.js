import express from "express";
import { DataSource } from "typeorm";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import Decimal from "decimal.js";
import { body, validationResult } from "express-validator";

// IMPORTANT: ESM requires file extensions for relative imports
import {
  DepositIntentSchema,
  WithdrawalIntentSchema,
  WithdrawalBatchSchema,
} from "./schemas.js";

// --- 1. Wallet Adapter (Mock) ---

class MockWalletAdapter {
  async createAddress(asset, network) {
    return `dev_addr_${network.toLowerCase()}_${uuidv4().substring(0, 8)}`;
  }

  async sendBatch(withdrawals, asset, network) {
    console.log(`[Adapter] Processing batch of ${withdrawals.length} items...`);
    await new Promise((r) => setTimeout(r, 1500)); // Simulate latency
    return `tx_${uuidv4()}`;
  }

  async getBalance(asset, network) {
    return { total: "1000.00", spendable: "900.00" };
  }
}

const walletAdapter = new MockWalletAdapter();

// --- 2. Configuration ---

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
};

// Retry logic for DB connection
const connectDB = async (retries = 5) => {
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
    synchronize: true, // Dev mode: Auto-sync schema
    logging: false,
  });

  while (retries) {
    try {
      await dataSource.initialize();
      console.log("Database connected successfully.");
      return dataSource;
    } catch (err) {
      console.error(
        `DB Connection Failed. Retries left: ${retries}`,
        err.message,
      );
      retries -= 1;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
  throw new Error("Could not connect to database after multiple attempts.");
};

// Global variables for App
let AppDataSource;
let redisConnection;
let provisionQueue;
let batchQueue;

// --- 3. Workers ---

const startWorkers = () => {
  // Address Provisioning Worker
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
        console.log(`[Worker] Address assigned for ${intentId}`);
      } catch (e) {
        console.error(e);
      }
    },
    { connection: redisConnection },
  );

  // Batching Worker
  new Worker(
    "withdrawal-batching",
    async (job) => {
      const { asset, network } = job.data;
      const queryRunner = AppDataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const pending = await queryRunner.manager.find(WithdrawalIntentSchema, {
          where: { status: "PENDING", asset, network },
          lock: { mode: "pessimistic_write" },
        });

        if (pending.length === 0) {
          await queryRunner.rollbackTransaction();
          return;
        }

        const batchRepo = queryRunner.manager.getRepository(
          WithdrawalBatchSchema,
        );
        const batch = batchRepo.create({ status: "CREATED", asset, network });
        const savedBatch = await batchRepo.save(batch);

        for (const item of pending) {
          item.status = "LOCKED";
          item.batchId = savedBatch.id;
          await queryRunner.manager.save(WithdrawalIntentSchema, item);
        }

        await queryRunner.commitTransaction();

        // Broadcast
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

          await AppDataSource.getRepository(WithdrawalBatchSchema).update(
            savedBatch.id,
            { status: "SENT", txid },
          );
          await AppDataSource.getRepository(WithdrawalIntentSchema).update(
            pending.map((p) => p.id),
            { status: "SENT", txid },
          );
          console.log(`[Worker] Batch ${savedBatch.id} sent: ${txid}`);
        } catch (err) {
          console.error("Batch send failed", err);
          await AppDataSource.getRepository(WithdrawalBatchSchema).update(
            savedBatch.id,
            { status: "FAILED" },
          );
        }
      } catch (err) {
        if (queryRunner.isTransactionActive)
          await queryRunner.rollbackTransaction();
        console.error("Batch worker error", err);
      } finally {
        await queryRunner.release();
      }
    },
    { connection: redisConnection },
  );
};

// --- 4. API & Bootstrap ---

const app = express();
app.use(express.json());

const validateBase = [
  body("asset").notEmpty(),
  body("network").notEmpty(),
  body("reference.idempotency_key").notEmpty(),
];

// Routes
app.post("/v1/deposit-intents", validateBase, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });

  const { asset, network, expected_amount, expires_at, reference, metadata } =
    req.body;
  const repo = AppDataSource.getRepository(DepositIntentSchema);

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
      return res.status(409).json({ code: "CONFLICT" });
    res.status(500).json({ error: e.message });
  }
});

app.get("/v1/deposit-intents/:id", async (req, res) => {
  const intent = await AppDataSource.getRepository(
    DepositIntentSchema,
  ).findOneBy({ id: req.params.id });
  if (!intent) return res.status(404).json({ code: "NOT_FOUND" });
  res.json({ ...intent, poll_after_ms: 3000 });
});

app.post("/v1/withdrawal-intents", validateBase, async (req, res) => {
  const { asset, network, amount, to_address, reference } = req.body;
  const repo = AppDataSource.getRepository(WithdrawalIntentSchema);

  const existing = await repo.findOneBy({
    idempotencyKey: reference.idempotency_key,
  });
  if (existing) return res.status(201).json(existing);

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

  const saved = await repo.save(intent);
  res.status(201).json(saved);
});

app.get("/v1/wallet-balance", async (req, res) => {
  const { asset, network } = req.query;
  const balance = await walletAdapter.getBalance(asset, network);
  res.json({ asset, network, status: "OK", ...balance });
});

// Initialization
const start = async () => {
  try {
    // Connect DB
    AppDataSource = await connectDB();

    // Connect Redis
    redisConnection = new Redis(redisConfig);
    provisionQueue = new Queue("provision-address", {
      connection: redisConnection,
    });
    batchQueue = new Queue("withdrawal-batching", {
      connection: redisConnection,
    });

    // Start Workers
    startWorkers();

    // Schedule periodic batches (Every 30 seconds for dev testing)
    const networks = [{ asset: "USDT", network: "TRON" }];
    for (const net of networks) {
      await batchQueue.add(`batch-${net.asset}-${net.network}`, net, {
        repeat: { every: 30 * 1000 },
        jobId: `batch-job-${net.asset}-${net.network}`,
      });
      console.log(`Scheduler registered for ${net.asset}/${net.network}`);
    }

    app.listen(3000, () =>
      console.log("Dev Wallet Service running on http://localhost:3000"),
    );
  } catch (e) {
    console.error("Critical Init Error:", e);
    process.exit(1);
  }
};

start();
