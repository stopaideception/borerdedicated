
const { getDatabase } = require("firebase-admin/database");
const { getApps, initializeApp, cert } = require("firebase-admin/app");

const THREE_HOURS = 3 * 60 * 60 * 1000;

function database() {
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

  return getDatabase();
}

function rewardForLevel(level) {
  if (level < 4) return 70;
  if (level < 8) return 70;
  return null;
}

function validNumber(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = req.headers["x-api-key"];

  if (!process.env.SERVER_API_KEY || key !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const playerId =
    req.method === "GET"
      ? req.query.playerId
      : req.body?.playerId;

  if (
    typeof playerId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(playerId)
  ) {
    return res.status(400).json({ error: "Invalid playerId" });
  }

  try {
    const ref = database().ref(`players/${playerId}`);

    // PATCH — сохранение данных
    if (req.method === "PATCH") {
      const body = req.body;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Invalid JSON" });
      }

      const fields = [
        "level",
        "loss",
        "totalWin",
        "userScore",
        "win",
        "winRow"
      ];

      const changes = {};

      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          if (!validNumber(body[field])) {
            return res.status(400).json({
              error: `Invalid field: ${field}`
            });
          }

          changes[field] = body[field];
        }
      }

      if (Object.keys(changes).length === 0) {
        return res.status(400).json({ error: "No fields" });
      }

      const now = Date.now();

      const result = await ref.transaction(current => {
        const player = current || {
          level: 0,
          loss: 0,
          totalWin: 0,
          userScore: 50,
          win: 0,
          winRow: 0
        };

        const oldScore = player.userScore;
        const updated = { ...player, ...changes };

        if (updated.userScore === 0) {
          if (oldScore !== 0 || updated.nextRewardAt == null) {
            updated.nextRewardAt = now + THREE_HOURS;
          }
        } else {
          updated.nextRewardAt = null;
        }

        return updated;
      }, undefined, false);

      return res.status(200).json({
        success: true,
        playerId,
        ...result.snapshot.val()
      });
    }

    // GET — загрузка и начисление награды
    if (req.method === "GET") {
      const snapshot = await ref.get();
      const currentPlayer = snapshot.val();

      if (!currentPlayer) {
        return res.status(404).json({
          error: "Player not found"
        });
      }

      const now = Date.now();

      const rewardDue =
        currentPlayer.userScore === 0 &&
        typeof currentPlayer.nextRewardAt === "number" &&
        now >= currentPlayer.nextRewardAt &&
        rewardForLevel(currentPlayer.level) !== null;

      if (rewardDue) {
        const result = await ref.transaction(current => {
          if (!current) return;

          const reward = rewardForLevel(current.level);

          if (
            current.userScore !== 0 ||
            typeof current.nextRewardAt !== "number" ||
            Date.now() < current.nextRewardAt ||
            reward === null
          ) {
            return;
          }

          return {
            ...current,
            userScore: reward,
            nextRewardAt: null
          };
        }, undefined, false);

        // Диагностика результата прямо в ответе GET
        if (!result.committed) {
          const latest = (await ref.get()).val();

          return res.status(200).json({
            success: true,
            playerId,
            rewardTransactionCommitted: false,
            ...latest
          });
        }
      }

      const player = (await ref.get()).val();

      if (!player) {
        return res.status(404).json({
          error: "Player not found"
        });
      }

      return res.status(200).json({
        success: true,
        playerId,
        ...player
      });
    }
  } catch (error) {
    console.error("Player API error:", error);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
};
