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
  { maxRank: 4,  reward: 50  },
  { maxRank: 9,  reward: 70  },
  { maxRank: 14, reward: 100 },
  { maxRank: 19, reward: 150 },
  { maxRank: 24, reward: 200 },
  { maxRank: 29, reward: 250 }
];
const MAX_TIER_REWARD = 250;

function rewardForLevel(level) {
  for (const tier of REWARD_TIERS) {
    if (level <= tier.maxRank) return tier.reward;
  }
  return MAX_TIER_REWARD;
}

// Любые имена полей из Blueprint: "User Score", "UserScore", "userScore",
// "UserScore_3_ABC...GUID" приводятся к нужному полю.
const FIELD_MAP = {
  level: "level",
  loss: "loss",
  totalwin: "totalWin",
  userscore: "userScore",
  win: "win",
  winrow: "winRow"
};

function norm(key) {
  return String(key)
    .replace(/_\d+_[0-9A-Fa-f]{32}$/, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

// Число или строка с числом -> целое >= 0, иначе null
function toInt(v) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

// Отдаём поля и в формате API, и в формате Blueprint
function withAliases(p) {
  return {
    ...p,
    "Level": p.level,
    "Loss": p.loss,
    "Total Win": p.totalWin,
    "User Score": p.userScore,
    "Win": p.win,
    "Win Row": p.winRow
  };
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
    ...(method === "PUT" ? { body: JSON.stringify(data) } : {})
  });

  if (response.status === 412) {
    return { conflict: true };
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Firebase HTTP ${response.status}: ${message}`);
  }

  return {
    conflict: false,
    data: await response.json(),
    etag: response.headers.get("etag")
  };
}

async function atomicUpdate(playerId, updater) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await firebaseRequest(playerId, "GET");

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
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Ключ принимается и в заголовке x-api-key, и в адресе ?key=...
  const apiKey = req.headers["x-api-key"] || req.query.key;

  if (!process.env.SERVER_API_KEY || apiKey !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Тело может прийти строкой или Buffer
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  // ID из адреса или из тела, хвост ".json" отрезается
  let playerId = req.query.playerId || (body && body.playerId);
  if (typeof playerId === "string") {
    playerId = playerId.replace(/\.json$/, "");
  }

  if (
    typeof playerId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(playerId)
  ) {
    return res.status(400).json({ error: "Invalid playerId" });
  }

  try {
    // ====================================
    // PATCH — СОХРАНЕНИЕ ДАННЫХ
    // ====================================
    if (req.method === "PATCH") {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Invalid JSON" });
      }

      const changes = {};
      for (const [k, v] of Object.entries(body)) {
        const field = FIELD_MAP[norm(k)];
        if (!field) continue;
        const n = toInt(v);
        if (n !== null) changes[field] = n;
      }

      if (Object.keys(changes).length === 0) {
        return res.status(400).json({ error: "No fields" });
      }

      const result = await atomicUpdate(playerId, current => {
        const player = current || defaultPlayer();
        const oldScore = player.userScore;

        const updated = { ...player, ...changes };

        if (updated.userScore === 0) {
          if (oldScore !== 0 || updated.nextRewardAt == null) {
            updated.nextRewardAt = Date.now() + THREE_HOURS;
          }
        } else {
          updated.nextRewardAt = null;
        }

        return { write: true, reason: "saved", player: updated };
      });

      return res.status(200).json({
        success: true,
        playerId,
        ...withAliases(result.player)
      });
    }

    // ====================================
    // GET — ЗАГРУЗКА И НАГРАДА
    // ====================================
    if (req.method === "GET") {
      const result = await atomicUpdate(playerId, current => {
        if (current === null) {
          return { write: false, reason: "player_not_found" };
        }

        if (current.userScore !== 0) {
          return { write: false, reason: "score_not_zero" };
        }

        if (typeof current.nextRewardAt !== "number") {
          return { write: false, reason: "no_reward_time" };
        }

        if (Date.now() < current.nextRewardAt) {
          return { write: false, reason: "waiting" };
        }

        return {
          write: true,
          reason: "reward_applied",
          player: {
            ...current,
            userScore: rewardForLevel(current.level),
            nextRewardAt: null
          }
        };
      });

      // Игрока нет: отвечаем null с кодом 200, как раньше отвечал Firebase
      if (result.player === null) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send("null");
      }

      return res.status(200).json({
        success: true,
        playerId,
        rewardTransactionCommitted: result.committed,
        transactionReason: result.reason,
        ...withAliases(result.player)
      });
    }
  } catch (error) {
    console.error("Player API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
