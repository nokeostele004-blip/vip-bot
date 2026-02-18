export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/qris-webhook") {
      return handleQrisWebhook(request, env);
    }

    if (request.method === "POST") {
      const update = await request.json();
      return handleTelegram(update, env);
    }

    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    await autoKickExpired(env);
  }
};

// ================= TELEGRAM =================

async function handleTelegram(update, env) {

  if (update.chat_join_request) {
    const req = update.chat_join_request;
    const active = await isActive(env, req.from.id, req.chat.id);
    if (active) {
      await tg("approveChatJoinRequest", {
        chat_id: req.chat.id,
        user_id: req.from.id
      }, env);
    }
    return new Response("OK");
  }

  if (!update.message && !update.callback_query) {
    return new Response("OK");
  }

  if (update.message) {
    const msg = update.message;

    if (msg.text === "/start") {
      return sendMenu(msg.chat.id, env);
    }

    if (msg.text?.startsWith("/addgroup") &&
        String(msg.from.id) === env.ADMIN_ID) {

      const [, gid, name, p1, p7, p30] = msg.text.split(" ");

      await env.DB.prepare(`
        INSERT OR REPLACE INTO groups
        VALUES (?, ?, ?, ?, ?)
      `).bind(gid, name, p1, p7, p30).run();

      return send(msg.chat.id, "Group ditambahkan", env);
    }
  }

  if (update.callback_query) {
    return handleCallback(update.callback_query, env);
  }

  return new Response("OK");
}

async function sendMenu(chatId, env) {
  const groups = await env.DB.prepare(
    `SELECT * FROM groups`
  ).all();

  const keyboard = {
    inline_keyboard: groups.results.map(g => ([
      {
        text: g.name,
        callback_data: `group_${g.telegram_group_id}`
      }
    ]))
  };

  return tg("sendMessage", {
    chat_id: chatId,
    text: "Pilih Grup VIP:",
    reply_markup: keyboard
  }, env);
}

async function handleCallback(q, env) {

  const data = q.data;
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  if (data.startsWith("group_")) {
    const gid = data.replace("group_", "");

    const g = await env.DB.prepare(
      `SELECT * FROM groups WHERE telegram_group_id=?`
    ).bind(gid).first();

    const keyboard = {
      inline_keyboard: [
        [{ text: "1 Hari", callback_data: `buy_${gid}_1d` }],
        [{ text: "7 Hari", callback_data: `buy_${gid}_7d` }],
        [{ text: "30 Hari", callback_data: `buy_${gid}_30d` }]
      ]
    };

    await tg("sendMessage", {
      chat_id: chatId,
      text: `Pilih Paket untuk ${g.name}`,
      reply_markup: keyboard
    }, env);
  }

  if (data.startsWith("buy_")) {

    const [, gid, dur] = data.split("_");

    const g = await env.DB.prepare(
      `SELECT * FROM groups WHERE telegram_group_id=?`
    ).bind(gid).first();

    const price = g[`price_${dur}`];
    const orderId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO transactions
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).bind(orderId, userId, gid, dur, price).run();

    const pay = await fetch("https://qris.pw/api/create-payment.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": env.QRIS_API_KEY,
        "X-API-Secret": env.QRIS_API_SECRET
      },
      body: JSON.stringify({
        amount: price,
        description: orderId
      })
    });

    const res = await pay.json();

    await send(chatId,
      `Silakan bayar:\n${res.qris_url}`,
      env
    );
  }

  await tg("answerCallbackQuery", {
    callback_query_id: q.id
  }, env);

  return new Response("OK");
}

// ================= PAYMENT WEBHOOK =================

async function handleQrisWebhook(request, env) {

  const body = await request.text();
  const data = JSON.parse(body);

  if (!await verify(body, data.signature, env.QRIS_WEBHOOK_SECRET)) {
    return new Response("Invalid", { status: 403 });
  }

  if (data.status !== "paid") {
    return new Response("OK");
  }

  const tx = await env.DB.prepare(
    `SELECT * FROM transactions WHERE order_id=?`
  ).bind(data.description).first();

  if (!tx || tx.status === "paid") {
    return new Response("OK");
  }

  const expire = Date.now() + durationMs(tx.duration);

  await env.DB.prepare(`
    INSERT OR REPLACE INTO subscriptions
    VALUES (?, ?, ?)
  `).bind(tx.telegram_user_id, tx.telegram_group_id, expire).run();

  await env.DB.prepare(`
    UPDATE transactions SET status='paid' WHERE order_id=?
  `).bind(tx.order_id).run();

  const invite = await tg("createChatInviteLink", {
    chat_id: tx.telegram_group_id,
    member_limit: 1,
    expire_date: Math.floor(expire / 1000)
  }, env);

  await send(tx.telegram_user_id,
    `Pembayaran sukses.\nLink:\n${invite.result.invite_link}`,
    env
  );

  return new Response("OK");
}

// ================= AUTO EXPIRE =================

async function autoKickExpired(env) {

  const now = Date.now();

  const subs = await env.DB.prepare(`
    SELECT * FROM subscriptions WHERE expire_at < ?
  `).bind(now).all();

  for (const s of subs.results) {

    await tg("banChatMember", {
      chat_id: s.telegram_group_id,
      user_id: s.telegram_user_id
    }, env);

    await tg("unbanChatMember", {
      chat_id: s.telegram_group_id,
      user_id: s.telegram_user_id
    }, env);

    await env.DB.prepare(`
      DELETE FROM subscriptions
      WHERE telegram_user_id=? AND telegram_group_id=?
    `).bind(s.telegram_user_id, s.telegram_group_id).run();
  }
}

// ================= UTIL =================

function durationMs(d) {
  if (d === "1d") return 86400000;
  if (d === "7d") return 604800000;
  if (d === "30d") return 2592000000;
  return 0;
}

async function isActive(env, uid, gid) {
  const s = await env.DB.prepare(`
    SELECT * FROM subscriptions
    WHERE telegram_user_id=? AND telegram_group_id=?
  `).bind(uid, gid).first();

  return s && s.expire_at > Date.now();
}

async function tg(method, body, env) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  return r.json();
}

async function send(chatId, text, env) {
  return tg("sendMessage", { chat_id: chatId, text }, env);
}

async function verify(payload, signature, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC", key, enc.encode(payload)
  );
  const hex = [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === signature;
}

