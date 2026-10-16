
const { getApps, initializeApp, cert } = require("firebase-admin/app");

const THREE_HOURS = 3 * 60 * 60 * 1000;
const MAX_RETRIES = 10;

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

const REWARD_TIERS = [
  { maxRank: 4,  reward: 50  }, // ранги 1-4:   простая кирка, угольный пласт
  { maxRank: 9,  reward: 70  }, // ранги 5-9:   улучшенная кирка, мраморная пещера
  { maxRank: 14, reward: 100 }, // ранги 10-14: ручной бур, рудная шахта
  { maxRank: 19, reward: 150 }, // ранги 15-19: перфоратор, серебряная шахта
  { maxRank: 24, reward: 200 }, // ранги 20-24: отбойный молоток, золотой рудник
  { maxRank: 29, reward: 250 }  // ранги 25-29: алмазная буровая, алмазный рудник
];

// Ранг 30+: пока то же, что у 25-29. Сюрпризы и бонусы добавим позже.
const MAX_TIER_REWARD = 250;

function rewardForLevel(level) {
  for (const tier of REWARD_TIERS) {
    if (level <= tier.maxRank) return tier.reward;
  }
  return MAX_TIER_REWARD;
}

function validNumber(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function defaultPlayer() {
  return {
    level: 0,
    loss: 0,
    totalWin: 0,
    userScore: 50,
    win: 0,
    winRow: 0
  };
}

async function firebaseRequest(playerId, method, data, etag) {
  const app = firebaseApp();
  const token = await app.options.credential.getAccessToken();

  const baseUrl = process.env.FIREBASE_DATABASE_URL.replace(/\/+$/, "");
  const url = `${baseUrl}/players/${encodeURIComponent(playerId)}.json`;

  const headers = {
    Authorization: `Bearer ${token.access_token}`
  };

  if (method === "GET") {
    headers["X-Firebase-ETag"] = "true";
  }

  if (method === "PUT") {
    headers["Content-Type"] = "application/json";
    headers["if-match"] = etag;
  }

  const response = await fetch(url, {
    method,
    headers,
    ...(method === "PUT"
      ? { body: JSON.stringify(data) }
      : {})
  });

  if (response.status === 412) {
    return { conflict: true };
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Firebase HTTP ${response.status}: ${message}`
    );
  }

  return {
    conflict: false,
    data: await response.json(),
    etag: response.headers.get("etag")
  };
}

async function atomicUpdate(playerId, updater) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await firebaseRequest(
      playerId,
      "GET"
    );

    if (!current.etag) {
      throw new Error("Firebase did not return ETag");
    }

    const decision = updater(current.data);

    if (!decision.write) {
      return {
        committed: false,
        reason: decision.reason,
        player: current.data
      };
    }

    const saved = await firebaseRequest(
      playerId,
      "PUT",
      decision.player,
      current.etag
    );

    if (saved.conflict) {
      continue;
    }

    return {
      committed: true,
      reason: decision.reason,
      player: saved.data
    };
  }

  throw new Error("Too many concurrent updates");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "PATCH") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (
    !process.env.SERVER_API_KEY ||
    req.headers["x-api-key"] !== process.env.SERVER_API_KEY
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const playerId =
    req.method === "GET"
      ? req.query.playerId
      : req.body?.playerId;

  if (
    typeof playerId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(playerId)
  ) {
    return res.status(400).json({
      error: "Invalid playerId"
    });
  }

  try {
    // ====================================
    // PATCH — СОХРАНЕНИЕ ДАННЫХ
    // ====================================

    if (req.method === "PATCH") {
      const body = req.body;

      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return res.status(400).json({
          error: "Invalid JSON"
        });
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
        if (
          Object.prototype.hasOwnProperty.call(body, field)
        ) {
          if (!validNumber(body[field])) {
            return res.status(400).json({
              error: `Invalid field: ${field}`
            });
          }

          changes[field] = body[field];
        }
      }

      if (Object.keys(changes).length === 0) {
        return res.status(400).json({
          error: "No fields"
        });
      }

      const result = await atomicUpdate(
        playerId,
        current => {
          const player = current || defaultPlayer();
          const oldScore = player.userScore;

          const updated = {
            ...player,
            ...changes
          };

          if (updated.userScore === 0) {
            if (
              oldScore !== 0 ||
              updated.nextRewardAt == null
            ) {
              updated.nextRewardAt =
                Date.now() + THREE_HOURS;
            }
          } else {
            updated.nextRewardAt = null;
          }

          return {
            write: true,
            reason: "saved",
            player: updated
          };
        }
      );

      return res.status(200).json({
        success: true,
        playerId,
        ...result.player
      });
    }

    // ====================================
    // GET — ЗАГРУЗКА И НАГРАДА
    // ====================================

    if (req.method === "GET") {
      const result = await atomicUpdate(
        playerId,
        current => {
          if (current === null) {
            return {
              write: false,
              reason: "player_not_found"
            };
          }

          if (current.userScore !== 0) {
            return {
              write: false,
              reason: "score_not_zero"
            };
          }

          if (
            typeof current.nextRewardAt !== "number"
          ) {
            return {
              write: false,
              reason: "no_reward_time"
            };
          }

          if (Date.now() < current.nextRewardAt) {
            return {
              write: false,
              reason: "waiting"
            };
          }

          const reward = rewardForLevel(current.level);

          if (reward === null) {
            return {
              write: false,
              reason: "no_reward_for_level"
            };
          }

          return {
            write: true,
            reason: "reward_applied",
            player: {
              ...current,
              userScore: reward,
              nextRewardAt: null
            }
          };
        }
      );

      if (result.player === null) {
        return res.status(404).json({
          error: "Player not found"
        });
      }

      return res.status(200).json({
        success: true,
        playerId,
        rewardTransactionCommitted: result.committed,
        transactionReason: result.reason,
        ...result.player
      });
    }

  } catch (error) {
    console.error("Player API error:", error);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
};
