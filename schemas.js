import { EntitySchema } from "typeorm";

/**
 * DepositIntent: Tracks incoming funds lifecycle.
 */
export const DepositIntentSchema = new EntitySchema({
  name: "DepositIntent",
  tableName: "deposit_intents",
  columns: {
    id: { primary: true, type: "uuid", generated: "uuid" },
    status: { type: "varchar", length: 30 }, // CREATED, ADDRESS_PENDING, CAPTURED, etc.
    asset: { type: "varchar", length: 20 },
    network: { type: "varchar", length: 20 },
    expectedAmount: { type: "decimal", precision: 36, scale: 18 },
    receivedAmount: { type: "decimal", precision: 36, scale: 18, default: "0" },
    address: { type: "varchar", length: 255, nullable: true },
    idempotencyKey: { type: "varchar", length: 128, unique: true },
    metadata: { type: "json", nullable: true },
    expiresAt: { type: "timestamp" },
    captureId: { type: "varchar", length: 128, nullable: true },
    capturedAt: { type: "timestamp", nullable: true },
    createdAt: { type: "timestamp", createDate: true },
  },
  indices: [
    { name: "IDX_DEPOSIT_KEY", columns: ["idempotencyKey"] },
    { name: "IDX_DEPOSIT_STATUS", columns: ["status"] },
  ],
});

/**
 * WithdrawalIntent: Tracks fund reservation and request status.
 */
export const WithdrawalIntentSchema = new EntitySchema({
  name: "WithdrawalIntent",
  tableName: "withdrawal_intents",
  columns: {
    id: { primary: true, type: "uuid", generated: "uuid" },
    status: { type: "varchar", length: 30 }, // PENDING, LOCKED, SENT, FAILED
    asset: { type: "varchar", length: 20 },
    network: { type: "varchar", length: 20 },
    amount: { type: "decimal", precision: 36, scale: 18 },
    toAddress: { type: "varchar", length: 255 },
    idempotencyKey: { type: "varchar", length: 128, unique: true },
    txid: { type: "varchar", length: 255, nullable: true },
    batchId: { type: "uuid", nullable: true },
    createdAt: { type: "timestamp", createDate: true },
  },
  indices: [
    { name: "IDX_WITHDRAWAL_KEY", columns: ["idempotencyKey"] },
    { name: "IDX_WITHDRAWAL_STATUS", columns: ["status"] },
  ],
});

/**
 * WithdrawalBatch: Audit log for grouped blockchain transactions.
 */
export const WithdrawalBatchSchema = new EntitySchema({
  name: "WithdrawalBatch",
  tableName: "withdrawal_batches",
  columns: {
    id: { primary: true, type: "uuid", generated: "uuid" },
    status: { type: "varchar", length: 30 }, // CREATED, SENDING, SENT, FAILED
    asset: { type: "varchar", length: 20 },
    network: { type: "varchar", length: 20 },
    txid: { type: "varchar", length: 255, nullable: true },
    createdAt: { type: "timestamp", createDate: true },
  },
});
