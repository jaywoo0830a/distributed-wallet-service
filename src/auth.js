// English comments only in code
import crypto from "crypto";

function hashShort(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

export function requireBearerAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ code: "unauthorized", message: "Missing or invalid bearer token." });
  }

  const token = auth.slice("Bearer ".length).trim();
  // In real life, validate JWT and derive user identity from claims.
  req.userId = "user_" + hashShort(token);
  next();
}
