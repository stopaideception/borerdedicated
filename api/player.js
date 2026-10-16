
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
  if (level < 4) return 50;
  if (level < 8) return 70;
  return null; // Для уровней 8+ правило добавим позже
}

function validNumber(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Только Dedicated Server может обращаться к API
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

    // PATCH — сохранение данных от Dedicated Server
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
          // Временная политика: положительный PATCH
          // отменяет ожидание пополнения.
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

    // GET — загрузка и проверка времени
    if (req.method === "GET") {
      const now = Date.now();

      const result = await ref.transaction(current => {
        if (!current) return;

        const player = { ...current };

        if (
          player.userScore === 0 &&
          typeof player.nextRewardAt === "number" &&
          now >= player.nextRewardAt
        ) {
          const reward = rewardForLevel(player.level);

          if (reward !== null) {
            player.userScore = reward;
            player.nextRewardAt = null;
            return player;
          }
        }

        // Нет изменений — транзакцию не записываем
        // Возвращаем данные игрока
      return player;
      }, undefined, false);

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
