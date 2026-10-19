const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const CODE_TTL_MS = 10 * 60 * 1000; // код живёт 10 минут

function firebaseApp() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
  return getApps()[0];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "PATCH" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Тот же ключ, что и в api/player
  const apiKey = req.headers["x-api-key"] || req.query.key;
  if (!process.env.SERVER_API_KEY || apiKey !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  // code из адреса (?code=...), playerId из адреса или из тела
  const code = String(req.query.code || (body && body.code) || "");
  let playerId = req.query.playerId || (body && body.playerId);
  if (typeof playerId === "string") playerId = playerId.replace(/\.json$/, "");

  if (!/^[A-Za-z0-9]{10,40}$/.test(code)) {
    return res.status(400).json({ error: "Invalid code" });
  }
  if (typeof playerId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(playerId)) {
    return res.status(400).json({ error: "Invalid playerId" });
  }

  try {
    const db = getDatabase(firebaseApp());

    // Старый код этого игрока удаляем, чтобы в базе не копились
    const prev = (await db.ref(`link_codes_by_player/${playerId}`).get()).val();

    const updates = {
      [`link_codes/${code}`]: { playerId, expiresAt: Date.now() + CODE_TTL_MS },
      [`link_codes_by_player/${playerId}`]: code
    };
    if (typeof prev === "string" && prev !== code) {
      updates[`link_codes/${prev}`] = null;
    }

    await db.ref().update(updates);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("link-code error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
