// English comments only in code
import { Queue } from "bullmq";

function redisConn() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  return { connection: { url } };
}

const depositQueue = new Queue("deposit", redisConn());
const withdrawalQueue = new Queue("withdrawal", redisConn());

export { depositQueue, withdrawalQueue, redisConn };
