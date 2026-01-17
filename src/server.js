// English comments only in code
import express from "express";
import { requireBearerAuth } from "./auth.js";
import depositRoutes from "./routes/deposits.js";
import withdrawalRoutes from "./routes/withdrawals.js";

const app = express();
app.use(express.json());

app.get("/up", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/v1", requireBearerAuth);
app.use("/v1", depositRoutes);
app.use("/v1", withdrawalRoutes);

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
