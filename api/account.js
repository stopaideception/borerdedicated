const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

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

  // Сайт стоит на другом адресе, поэтому браузеру нужно разрешение (CORS).
  // Доступ защищён входом через Google (Bearer), а не адресом.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Кто вошёл на сайте: проверяем Firebase ID token
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return res.status(401).json({ error: "Unauthorized" });

  let uid;
  try {
    uid = (await getAuth(firebaseApp()).verifyIdToken(m[1])).uid;
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const db = getDatabase(firebaseApp());

    // ====================================
    // POST — ПРИВЯЗКА АККАУНТА ПО КОДУ
    // ====================================
    if (req.method === "POST") {
      let body = req.body;
      if (Buffer.isBuffer(body)) body = body.toString("utf8");
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
      }

      const code = String((body && body.code) || "");
      if (!/^[A-Za-z0-9]{10,40}$/.test(code)) {
        return res.status(400).json({ error: "invalid_code" });
      }

      // Код одноразовый: забираем его (удаляем) и запоминаем, что в нём было
      let claimed = null;
      await db.ref(`link_codes/${code}`).transaction(cur => {
        claimed = cur;
        return cur === null ? cur : null;
      });

      if (
        !claimed ||
        typeof claimed.expiresAt !== "number" ||
        claimed.expiresAt < Date.now() ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(claimed.playerId)
      ) {
        return res.status(400).json({ error: "invalid_or_expired_code" });
      }
      const playerId = claimed.playerId;

      // Этот Google-аккаунт уже привязан?
      const existing = (await db.ref(`links/${uid}`).get()).val();
      if (existing) {
        if (existing === playerId) return res.status(200).json({ success: true });
        return res.status(409).json({ error: "account_already_linked" });
      }

      // Этого игрока уже занял другой аккаунт?
      const claim = await db
        .ref(`player_links/${playerId}`)
        .transaction(cur => (cur === null || cur === uid ? uid : undefined));
      if (!claim.committed) {
        return res.status(409).json({ error: "player_already_linked" });
      }

      await db.ref().update({
        [`links/${uid}`]: playerId,
        [`link_codes_by_player/${playerId}`]: null
      });

      return res.status(200).json({ success: true });
    }

    // ====================================
    // GET — ДАННЫЕ ИГРОКА ДЛЯ САЙТА
    // ====================================
    const playerId = (await db.ref(`links/${uid}`).get()).val();
    if (!playerId) return res.status(200).json({ linked: false });

    const p = (await db.ref(`players/${playerId}`).get()).val() || {};
    return res.status(200).json({
      linked: true,
      level: p.level ?? 1,
      userScore: p.userScore ?? 0,
      win: p.win ?? 0,
      loss: p.loss ?? 0,
      totalWin: p.totalWin ?? 0,
      winRow: p.winRow ?? 0,
      nextRewardAt: p.nextRewardAt ?? null
    });
  } catch (error) {
    console.error("Account API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
