// English comments only in code
import knexLib from "knex";

let knex;

export function getKnex() {
  if (knex) return knex;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  knex = knexLib({
    client: "mysql2",
    connection: url,
    pool: { min: 0, max: 10 }
  });
  return knex;
}
