// English comments only in code
import knexLib from "knex";

function knexFromEnv() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return knexLib({
    client: "mysql2",
    connection: url,
    pool: { min: 0, max: 10 }
  });
}

async function ensureTable(knex, name, builder) {
  const exists = await knex.schema.hasTable(name);
  if (!exists) {
    await knex.schema.createTable(name, builder);
  }
}

(async () => {
  const knex = knexFromEnv();

  await ensureTable(knex, "idempotency_keys", (t) => {
    t.bigIncrements("id").primary();
    t.string("scope", 64).notNullable();
    t.string("ikey", 191).notNullable();
    t.string("fingerprint", 64).notNullable();
    t.string("resource_type", 32).notNullable();
    t.string("resource_id", 64).notNullable();
    t.timestamp("created_at").defaultTo(knex.fn.now());
    t.unique(["scope", "ikey"]);
  });

  await ensureTable(knex, "deposit_intents", (t) => {
    t.string("id", 64).primary();
    t.string("user_id", 64).notNullable();
    t.string("asset", 32).notNullable();
    t.string("network", 32).notNullable();
    t.string("expected_amount", 64).notNullable();
    t.string("received_amount", 64).notNullable().defaultTo("0");
    t.integer("min_confirmations").notNullable().defaultTo(0);
    t.integer("current_confirmations").notNullable().defaultTo(0);
    t.string("status", 32).notNullable();
    t.string("address", 128).nullable();
    t.json("eligibility").nullable();
    t.json("capture").nullable();
    t.json("failure").nullable();
    t.json("reference").notNullable();
    t.json("metadata").notNullable();
    t.dateTime("expires_at").notNullable();
    t.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
    t.dateTime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.index(["user_id"]);
    t.index(["status"]);
  });

  await ensureTable(knex, "deposit_captures", (t) => {
    t.bigIncrements("id").primary();
    t.string("deposit_intent_id", 64).notNullable();
    t.string("ikey", 191).notNullable();
    t.string("fingerprint", 64).notNullable();
    t.json("result_snapshot").notNullable();
    t.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
    t.unique(["deposit_intent_id", "ikey"]);
    t.index(["deposit_intent_id"]);
  });

  await ensureTable(knex, "withdrawal_intents", (t) => {
    t.string("id", 64).primary();
    t.string("user_id", 64).notNullable();
    t.string("asset", 32).notNullable();
    t.string("network", 32).notNullable();
    t.string("amount", 64).notNullable();
    t.string("to_address", 128).notNullable();
    t.string("status", 32).notNullable();
    t.json("tx").nullable();
    t.json("failure").nullable();
    t.json("debug").nullable();
    t.json("reference").notNullable();
    t.json("metadata").notNullable();
    t.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
    t.dateTime("updated_at").notNullable().defaultTo(knex.fn.now());
    t.index(["user_id"]);
    t.index(["status"]);
  });

  await ensureTable(knex, "job_locks", (t) => {
    t.string("job_key", 191).primary();
    t.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.destroy();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
