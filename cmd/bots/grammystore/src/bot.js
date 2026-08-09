import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { randomInt } from "node:crypto";
import { buildPayload, findProduct, KINDS, normalizeUsername, parsePayload, productsOfKind } from "./catalog.js";

const spinPrizes = [{ amount: 50, weight: 250 }, { amount: 100, weight: 130 }, { amount: 500, weight: 50 }, { amount: 1000, weight: 30 }, { amount: 10000, weight: 10 }, { amount: 15, weight: 530 }];
const text = {
  ru: {
    hello: "👋 <b>Добро пожаловать!</b>\n\nЗдесь можно получать номера и коды, покупать Stars, Premium и коллекционные активы.",
    menu: "🏠 <b>Главное меню</b>", numbers: "📱 <b>Ваши номера</b>", noCode: "Код ещё не поступал.",
    shop: "🛒 <b>Магазин</b>\nВыберите раздел:", bonuses: "🎁 <b>Бонусы</b>", settings: "⚙️ <b>Настройки</b>",
    support: "💬 Отправьте одним сообщением вопрос для поддержки.", target: "Введите числовой ID пользователя в {product}.",
    account: "Введите ваш числовой ID аккаунта {product}. Он будет использоваться для бонусов и покупок себе.",
  },
  en: {
    hello: "👋 <b>Welcome!</b>\n\nGet numbers and login codes, or buy Stars, Premium and collectibles.",
    menu: "🏠 <b>Main menu</b>", numbers: "📱 <b>Your numbers</b>", noCode: "No login code has arrived yet.",
    shop: "🛒 <b>Store</b>\nChoose a section:", bonuses: "🎁 <b>Bonuses</b>", settings: "⚙️ <b>Settings</b>",
    support: "💬 Send your support question in one message.", target: "Enter the numeric {product} user ID.",
    account: "Enter your numeric {product} account ID. It is used for bonuses and purchases for yourself.",
  },
};

function escapeHTML(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function language(db, id, fallback) { return db.user(id)?.language ?? fallback; }
function t(db, id, fallback, key, productName = "Telesrv") { return text[language(db, id, fallback)][key].replaceAll("{product}", productName); }
function isOwner(config, id) { return config.ownerIDs.has(id); }
function userName(from) { return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" "); }
function initialLanguage(from, fallback) { const code = String(from?.language_code ?? "").toLowerCase(); return code.startsWith("ru") ? "ru" : code ? "en" : fallback; }

function mainKeyboard(admin = false) {
  const kb = new InlineKeyboard().text("📱 Номера", "menu:numbers").text("🛒 Магазин", "menu:shop").row()
    .text("🎁 Бонусы", "menu:bonuses").text("👥 Рефералы", "menu:referrals").row()
    .text("💬 Поддержка", "menu:support").text("⚙️ Настройки", "menu:settings");
  if (admin) kb.row().text("🛡 Админ-панель", "admin:menu");
  return kb;
}
function backKeyboard(target = "menu:home") { return new InlineKeyboard().text("‹ Назад", target); }
function shopKeyboard() { return new InlineKeyboard().text("👑 Premium", "shop:premium").text("⭐ Stars", "shop:stars").row().text("📱 +888", "shop:number").text("💎 NFT username", "shop:username").row().text("‹ Назад", "menu:home"); }
function settingsKeyboard(user) { return new InlineKeyboard().text("🆔 ID аккаунта", "settings:account").row().text("🌐 Русский", "settings:lang:ru").text("🌐 English", "settings:lang:en").row().text(user.notifications ? "🔔 Уведомления: да" : "🔕 Уведомления: нет", "settings:notifications").row().text("‹ Назад", "menu:home"); }
function adminKeyboard() { return new InlineKeyboard().text("📊 Статистика", "admin:stats").text("📣 Рассылка", "admin:broadcast").row().text("⭐ Выдать Stars", "admin:stars").text("💎 Выдать Premium", "admin:premium").row().text("🎟 Промокод", "admin:promo").text("🎁 Розыгрыш", "admin:giveaway").row().text("🎁 Выдать бонус", "admin:bonus").text("🧾 Счёт", "admin:invoice").row().text("📨 Доступ к кодам", "admin:access").text("↩️ Возврат", "admin:refund").row().text("💬 Ответить", "admin:reply").text("📈 Продажи", "admin:sales").row().text("⚙️ Курс Stars", "admin:rate").row().text("‹ Назад", "menu:home"); }

async function editOrReply(ctx, message, keyboard = undefined) {
  const options = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard };
  if (ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(message, options); } catch (error) { if (!String(error.description ?? error).includes("message is not modified")) throw error; }
  }
  return ctx.reply(message, options);
}

async function subscribed(ctx, config) {
  if (!config.requiredChannel || isOwner(config, ctx.from.id)) return true;
  try { const member = await ctx.api.getChatMember(config.requiredChannel, ctx.from.id); return ["creator", "administrator", "member", "restricted"].includes(member.status); }
  catch { return false; }
}

async function subscriptionGate(ctx, config) {
  const kb = new InlineKeyboard();
  if (config.requiredChannelURL) kb.url("📣 Открыть канал", config.requiredChannelURL).row();
  kb.text("✅ Я подписался", "subscription:check");
  await editOrReply(ctx, "🔒 Для использования бота подпишитесь на обязательный канал, затем нажмите кнопку проверки.", kb);
}

function parseStartRef(ctx) {
  const match = String(ctx.match ?? "").match(/^ref_(\d+)$/); return match ? Number(match[1]) : 0;
}

function productText(product) {
  const extra = product.kind === KINDS.username ? `\nСтавка: <b>${product.bid} TON</b>` : product.kind === KINDS.stars ? `\nБудет начислено: <b>${product.starsAmount}</b>` : "";
  return `<b>${escapeHTML(product.title)}</b>\n\n${escapeHTML(product.description)}\n\nЦена: <b>${product.starsPrice} ⭐</b>${extra}`;
}

function productKeyboard(product, db, buyerID) {
  const kb = new InlineKeyboard();
  if (product.kind === KINDS.number) return kb.text(`Купить за ${product.starsPrice} ⭐`, `buy:${product.code}:0`).row().text("‹ Назад", `shop:${product.kind}`);
  const selfID = db.user(buyerID)?.server_user_id ?? 0;
  if (selfID > 0) kb.text("Купить себе", `buy:${product.code}:${selfID}`).row();
  kb.text("Подарить / другой ID", `target:${product.code}`).row();
  for (const id of db.recentRecipients(buyerID)) kb.text(`ID ${id}`, `buy:${product.code}:${id}`);
  return kb.row().text("‹ Назад", `shop:${product.kind}`);
}

async function sendInvoice(ctx, product, targetUserID, extra = "") {
  await ctx.api.sendInvoice(ctx.chat.id, product.title, product.description, buildPayload(product.code, targetUserID, extra), "XTR", [{ label: product.title, amount: product.starsPrice }]);
}

function rollPrize() {
  const total = spinPrizes.reduce((sum, value) => sum + value.weight, 0); let value = randomInt(total);
  for (const prize of spinPrizes) { value -= prize.weight; if (value < 0) return prize.amount; }
  return 15;
}

export function createBot({ config, db, gramsrv }) {
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat) db.upsertUser(ctx.from, ctx.chat.id, initialLanguage(ctx.from, config.defaultLanguage));
    await next();
  });

  bot.command("start", async (ctx) => {
    const referrer = parseStartRef(ctx);
    const existed = db.user(ctx.from.id);
    db.upsertUser(ctx.from, ctx.chat.id, initialLanguage(ctx.from, config.defaultLanguage), referrer, config.referralBonus);
    if (!(await subscribed(ctx, config))) return subscriptionGate(ctx, config);
    const number = db.createNumber(ctx.from.id, ctx.chat.id, "free", config.defaultNumberCountry, false);
    const referralNotice = !existed && referrer > 0 ? "\n\n✅ Реферальное приглашение учтено." : "";
    await ctx.reply(`${t(db, ctx.from.id, config.defaultLanguage, "hello")}\n\n📞 Ваш номер: <code>${escapeHTML(number.display)}</code>\n🔑 Начальный код: <code>${number.login_code}</code>${referralNotice}`, { parse_mode: "HTML", reply_markup: mainKeyboard(isOwner(config, ctx.from.id)) });
  });

  bot.command("menu", async (ctx) => editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "menu"), mainKeyboard(isOwner(config, ctx.from.id))));
  bot.command("admin", async (ctx) => { if (isOwner(config, ctx.from.id)) await editOrReply(ctx, "🛡 <b>Админ-панель</b>", adminKeyboard()); });
  bot.command("promo_code", async (ctx) => {
    const [code, rawID] = String(ctx.match ?? "").trim().split(/\s+/); const serverID = Number(rawID || db.user(ctx.from.id)?.server_user_id);
    if (!code || !Number.isSafeInteger(serverID) || serverID <= 0) return ctx.reply(`Формат: /promo_code CODE ${config.productName.toUpperCase()}_ID`);
    try {
      const promo = db.claimPromo(code, ctx.from.id);
      try { await gramsrv.grantStars(serverID, promo.stars_amount, `Promo ${code}`, `promo:${code.toLowerCase()}:${ctx.from.id}`); }
      catch (error) { db.releaseCampaignClaim("promo", code.toLowerCase(), ctx.from.id); throw error; }
      await ctx.reply(`✅ Начислено ${promo.stars_amount} Stars.`);
    } catch (error) { await ctx.reply(`⚠️ ${escapeHTML(error.message)}`, { parse_mode: "HTML" }); }
  });

  bot.on("pre_checkout_query", async (ctx) => {
    try {
      if (ctx.preCheckoutQuery.currency !== "XTR") throw new Error("unsupported currency");
      if (!ctx.preCheckoutQuery.invoice_payload.startsWith("custom|")) {
        const parsed = parsePayload(ctx.preCheckoutQuery.invoice_payload); const product = findProduct(parsed.code, db.starsRate());
        if (!product || product.starsPrice !== ctx.preCheckoutQuery.total_amount) throw new Error("product price changed");
      }
      await ctx.answerPreCheckoutQuery(true);
    }
    catch { await ctx.answerPreCheckoutQuery(false, { error_message: "Некорректный или устаревший заказ." }); }
  });

  async function fulfill(product, recipientID, buyer, chatID, chargeID, extra = "") {
    if (product.kind !== KINDS.number && (!Number.isSafeInteger(recipientID) || recipientID <= 0)) throw new Error(`recipient ${config.productName} ID is invalid`);
    if (db.saleByCharge(chargeID)) return;
    const key = `payment:${chargeID}:${product.code}`;
    let number = null;
    if (product.kind === KINDS.premium) await gramsrv.grantPremium(recipientID, product.months, "Telegram bot purchase", key);
    else if (product.kind === KINDS.stars) await gramsrv.grantStars(recipientID, product.starsAmount, "Telegram bot purchase", key);
    else if (product.kind === KINDS.username) {
      const username = normalizeUsername(extra); if (!username) throw new Error("collectible username is invalid");
      await gramsrv.mintUsername(recipientID, username, product.bid, key);
    } else if (product.kind === KINDS.number) {
      number = db.createNumber(buyer.id, chatID, product.numberFormat, "ANON", true);
    }
    db.addSale({ product: product.code, title: product.title, starsPrice: product.starsPrice, recipientID, buyerID: buyer.id, buyerName: userName(buyer), chargeID });
    if (number) await bot.api.sendMessage(chatID, `✅ Номер зарезервирован: <code>${escapeHTML(number.display)}</code>`, { parse_mode: "HTML" }).catch(() => {});
    else await bot.api.sendMessage(chatID, `✅ <b>${escapeHTML(product.title)}</b> выдано пользователю <code>${recipientID}</code>.`, { parse_mode: "HTML" }).catch(() => {});
  }

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    if (!db.beginPayment(payment.telegram_payment_charge_id, ctx.from.id, payment.invoice_payload, payment.total_amount)) return;
    try {
      if (payment.invoice_payload.startsWith("custom|")) {
        const title = Buffer.from(payment.invoice_payload.slice(7), "base64url").toString("utf8");
        db.addSale({ product: "custom", title, starsPrice: payment.total_amount, recipientID: ctx.from.id, buyerID: ctx.from.id, buyerName: userName(ctx.from), chargeID: payment.telegram_payment_charge_id });
        await ctx.reply(`✅ Оплата «${escapeHTML(title)}» получена.`, { parse_mode: "HTML" });
      } else {
        const parsed = parsePayload(payment.invoice_payload);
        const product = findProduct(parsed.code, db.starsRate()); if (!product) throw new Error("product no longer exists");
        if (payment.currency !== "XTR" || payment.total_amount !== product.starsPrice) throw new Error("paid amount does not match the product");
        const recipient = parsed.targetUserID || db.user(ctx.from.id)?.server_user_id || 0;
        await fulfill(product, recipient, ctx.from, ctx.chat.id, payment.telegram_payment_charge_id, parsed.extra);
      }
      db.finishPayment(payment.telegram_payment_charge_id);
    } catch (error) {
      db.failPayment(payment.telegram_payment_charge_id, error);
      await ctx.reply(`⚠️ Оплата получена, но автоматическая выдача не завершена. Передайте поддержке чек <code>${escapeHTML(payment.telegram_payment_charge_id)}</code>.`, { parse_mode: "HTML" });
      for (const owner of config.ownerIDs) await bot.api.sendMessage(owner, `⚠️ Ошибка выдачи ${escapeHTML(payment.telegram_payment_charge_id)}: ${escapeHTML(error.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  bot.callbackQuery(/^subscription:check$/, async (ctx) => { await ctx.answerCallbackQuery(); if (await subscribed(ctx, config)) await editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "menu"), mainKeyboard(isOwner(config, ctx.from.id))); else await subscriptionGate(ctx, config); });
  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const page = ctx.match[1]; const user = db.user(ctx.from.id);
    if (page === "home") return editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "menu"), mainKeyboard(isOwner(config, ctx.from.id)));
    if (page === "numbers") {
      const numbers = db.numbers(ctx.from.id); const current = db.currentNumber(ctx.from.id);
      const list = numbers.slice(0, 10).map((number) => `${number.is_current ? "▶️" : "▫️"} <code>${escapeHTML(number.display)}</code>`).join("\n");
      const code = current?.login_code && current.code_expires_at >= Math.floor(Date.now() / 1000) ? `<code>${current.login_code}</code>` : t(db, ctx.from.id, config.defaultLanguage, "noCode");
      return editOrReply(ctx, `${t(db, ctx.from.id, config.defaultLanguage, "numbers")}\n\n${list || "—"}\n\n🔑 ${code}`, new InlineKeyboard().text("🔄 Новый бесплатный номер", "numbers:new").row().text("‹ Назад", "menu:home"));
    }
    if (page === "shop") return editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "shop"), shopKeyboard());
    if (page === "bonuses") return editOrReply(ctx, `${t(db, ctx.from.id, config.defaultLanguage, "bonuses")}\n\nБаланс: <b>${user.bonus}</b>\nРефералов: <b>${user.referral_count}</b>`, new InlineKeyboard().text("🎁 Ежедневный бонус", "bonus:daily").text("🎡 Рулетка", "bonus:spin").row().text("‹ Назад", "menu:home"));
    if (page === "referrals") {
      const username = config.publicUsername || bot.botInfo?.username || "bot"; const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
      return editOrReply(ctx, `👥 <b>Реферальная система</b>\n\nПриглашено: <b>${user.referral_count}</b>\nБонус за приглашение: <b>${config.referralBonus}</b>\n\n<code>${link}</code>`, backKeyboard());
    }
    if (page === "support") { db.setPending(ctx.from.id, "support"); return editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "support"), backKeyboard()); }
    if (page === "settings") return editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "settings"), settingsKeyboard(user));
  });

  bot.callbackQuery(/^numbers:new$/, async (ctx) => { await ctx.answerCallbackQuery(); await editOrReply(ctx, "🌍 Выберите страну нового бесплатного номера:", new InlineKeyboard().text("🇷🇺 Россия", "numbers:new:RU").text("🇺🇸 США", "numbers:new:US").row().text("‹ Назад", "menu:numbers")); });
  bot.callbackQuery(/^numbers:new:(RU|US)$/, async (ctx) => { await ctx.answerCallbackQuery(); const number = db.createNumber(ctx.from.id, ctx.chat.id, "free", ctx.match[1], true); await editOrReply(ctx, `✅ Новый номер: <code>${escapeHTML(number.display)}</code>\nНачальный код: <code>${number.login_code}</code>`, backKeyboard("menu:numbers")); });
  bot.callbackQuery(/^shop:(premium|stars|number|username)$/, async (ctx) => { await ctx.answerCallbackQuery(); const kind = ctx.match[1]; const kb = new InlineKeyboard(); for (const product of productsOfKind(kind, db.starsRate())) kb.text(`${product.title} · ${product.starsPrice}⭐`, `product:${product.code}`).row(); if (kind === KINDS.stars) kb.text("✍️ Другая сумма", "stars:custom").row(); kb.text("‹ Назад", "menu:shop"); await editOrReply(ctx, "Выберите товар:", kb); });
  bot.callbackQuery(/^stars:custom$/, async (ctx) => { await ctx.answerCallbackQuery(); db.setPending(ctx.from.id, "stars_amount"); await editOrReply(ctx, "Сколько Telegram Stars вы хотите потратить? Введите число от 1 до 99999.", backKeyboard("shop:stars")); });
  bot.callbackQuery(/^product:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const product = findProduct(ctx.match[1], db.starsRate()); if (!product) return; await editOrReply(ctx, productText(product), productKeyboard(product, db, ctx.from.id)); });
  bot.callbackQuery(/^target:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); db.setPending(ctx.from.id, "target", { productCode: ctx.match[1] }); await editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "target", config.productName), backKeyboard(`product:${ctx.match[1]}`)); });
  bot.callbackQuery(/^buy:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const product = findProduct(ctx.match[1], db.starsRate()); const targetID = Number(ctx.match[2]); if (!product) return;
    if (product.kind === KINDS.username) { db.setPending(ctx.from.id, "username", { productCode: product.code, targetID }); return editOrReply(ctx, "Введите желаемый username (без @):", backKeyboard(`product:${product.code}`)); }
    if (targetID > 0 && targetID !== db.user(ctx.from.id)?.server_user_id) db.rememberRecipient(ctx.from.id, targetID);
    if (isOwner(config, ctx.from.id)) { await fulfill(product, targetID, ctx.from, ctx.chat.id, `owner-${Date.now()}`); return; }
    await sendInvoice(ctx, product, targetID);
  });

  bot.callbackQuery(/^settings:lang:(ru|en)$/, async (ctx) => { db.setLanguage(ctx.from.id, ctx.match[1]); await ctx.answerCallbackQuery({ text: "OK" }); await editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "settings"), settingsKeyboard(db.user(ctx.from.id))); });
  bot.callbackQuery(/^settings:notifications$/, async (ctx) => { const enabled = db.toggleNotifications(ctx.from.id); await ctx.answerCallbackQuery({ text: enabled ? "Включены" : "Выключены" }); await editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "settings"), settingsKeyboard(db.user(ctx.from.id))); });
  bot.callbackQuery(/^settings:account$/, async (ctx) => { await ctx.answerCallbackQuery(); db.setPending(ctx.from.id, "account"); await editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "account", config.productName), backKeyboard("menu:settings")); });
  bot.callbackQuery(/^bonus:daily$/, async (ctx) => { const result = db.claimDaily(ctx.from.id, config.dailyBonus); await ctx.answerCallbackQuery({ text: result.claimed ? `+${config.dailyBonus}` : "Уже получен сегодня" }); await editOrReply(ctx, `${t(db, ctx.from.id, config.defaultLanguage, "bonuses")}\n\nБаланс: <b>${result.balance}</b>`, backKeyboard("menu:bonuses")); });
  bot.callbackQuery(/^bonus:spin$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const user = db.user(ctx.from.id); if (!user.server_user_id) { db.setPending(ctx.from.id, "account"); return editOrReply(ctx, t(db, ctx.from.id, config.defaultLanguage, "account", config.productName), backKeyboard("menu:bonuses")); }
    try { const award = db.reserveSpin(ctx.from.id, user.server_user_id, rollPrize()); await gramsrv.grantStars(user.server_user_id, award.prize, "Daily bot wheel", `spin:${ctx.from.id}:${award.day}`); db.finishSpin(ctx.from.id, award.day); await editOrReply(ctx, `🎉 Вы выиграли <b>${award.prize} Stars</b>!`, backKeyboard("menu:bonuses")); }
    catch (error) { await editOrReply(ctx, `⚠️ ${escapeHTML(error.message)}`, backKeyboard("menu:bonuses")); }
  });

  bot.callbackQuery(/^giveaway:([a-f0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const user = db.user(ctx.from.id); if (!user.server_user_id) return ctx.reply(`Сначала укажите ${config.productName} ID в настройках.`); const id = ctx.match[1]; try { const item = db.claimGiveaway(id, ctx.from.id); try { await gramsrv.grantStars(user.server_user_id, item.stars_amount, `Giveaway ${id}`, `giveaway:${id}:${ctx.from.id}`); } catch (error) { db.releaseCampaignClaim("giveaway", id, ctx.from.id); throw error; } await ctx.reply(`✅ Получено ${item.stars_amount} Stars.`); } catch (error) { await ctx.reply(`⚠️ ${error.message}`); } });

  bot.callbackQuery(/^admin:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); if (!isOwner(config, ctx.from.id)) return; const action = ctx.match[1];
    if (action === "menu") return editOrReply(ctx, "🛡 <b>Админ-панель</b>", adminKeyboard());
    if (action === "stats") { const stats = db.stats(); return editOrReply(ctx, `📊 Пользователи: <b>${stats.users}</b>\nНомера: <b>${stats.numbers}</b>\nПродажи: <b>${stats.sales}</b>`, backKeyboard("admin:menu")); }
    if (action === "sales") { const lines = db.recentSales().map((sale) => `${sale.id}. ${escapeHTML(sale.product)} → <code>${sale.recipient_id}</code> · ${sale.stars_price}⭐`).join("\n"); return editOrReply(ctx, `📈 <b>Последние продажи</b>\n\n${lines || "—"}`, backKeyboard("admin:menu")); }
    const prompts = {
      broadcast: "Введите текст рассылки.",
      stars: `Формат: ${config.productName.toUpperCase()}_ID AMOUNT`,
      premium: `Формат: ${config.productName.toUpperCase()}_ID MONTHS`,
      promo: "Формат: CODE STARS LIMIT",
      giveaway: "Формат: STARS LIMIT Текст акции",
      bonus: "Формат: TELEGRAM_ID AMOUNT",
      invoice: "Формат: TELEGRAM_ID STARS Название",
      access: "Формат: PHONE TELEGRAM_ID",
      refund: "Отправьте transaction ID платежа Telegram Stars.",
      reply: "Формат: TICKET_ID текст ответа",
      rate: "Введите новый курс: сколько server Stars за 1 Telegram Star.",
    };
    if (prompts[action]) { db.setPending(ctx.from.id, `admin_${action}`, { operationID: `admin:${ctx.from.id}:${Date.now()}:${randomInt(1_000_000)}` }); return editOrReply(ctx, prompts[action], backKeyboard("admin:menu")); }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return; const pending = db.pending(ctx.from.id); if (!pending) return;
    const input = ctx.message.text.trim();
    try {
      if (pending.kind === "account") { const id = Number(input); if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid ID"); db.setServerUserID(ctx.from.id, id); db.clearPending(ctx.from.id); return ctx.reply(`✅ ${config.productName} ID: ${id}`, { reply_markup: mainKeyboard(isOwner(config, ctx.from.id)) }); }
      if (pending.kind === "stars_amount") { const stars = Number(input); if (!Number.isSafeInteger(stars) || stars <= 0 || stars > 99999) throw new Error("amount must be from 1 to 99999"); const product = findProduct(`stars_${stars}`, db.starsRate()); db.clearPending(ctx.from.id); return ctx.reply(productText(product), { parse_mode: "HTML", reply_markup: productKeyboard(product, db, ctx.from.id) }); }
      if (pending.kind === "target") { const id = Number(input); if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid ID"); const product = findProduct(pending.payload.productCode, db.starsRate()); if (!product) throw new Error("product not found"); db.rememberRecipient(ctx.from.id, id); db.clearPending(ctx.from.id); if (product.kind === KINDS.username) { db.setPending(ctx.from.id, "username", { productCode: product.code, targetID: id }); return ctx.reply("Введите желаемый username без @:"); } if (isOwner(config, ctx.from.id)) return fulfill(product, id, ctx.from, ctx.chat.id, `owner-${Date.now()}`); await sendInvoice(ctx, product, id); return; }
      if (pending.kind === "username") { const username = normalizeUsername(input); if (!username) throw new Error("username must be 5-32 latin characters and start with a letter"); const product = findProduct(pending.payload.productCode, db.starsRate()); db.clearPending(ctx.from.id); if (isOwner(config, ctx.from.id)) return fulfill(product, pending.payload.targetID, ctx.from, ctx.chat.id, `owner-${Date.now()}`, username); await sendInvoice(ctx, product, pending.payload.targetID, username); return; }
      if (pending.kind === "support") { const ticket = db.addSupportMessage(ctx.from.id, ctx.chat.id, input); db.clearPending(ctx.from.id); for (const owner of config.ownerIDs) await bot.api.sendMessage(owner, `💬 Тикет #${ticket}\nОт: ${escapeHTML(userName(ctx.from))} (<code>${ctx.from.id}</code>)\n\n${escapeHTML(input)}`, { parse_mode: "HTML" }); return ctx.reply(`✅ Обращение #${ticket} отправлено.`); }
      if (!isOwner(config, ctx.from.id)) return;
      if (pending.kind === "admin_broadcast") { db.clearPending(ctx.from.id); let ok = 0, failed = 0; for (const user of db.users()) { try { await bot.api.sendMessage(user.chat_id, input, { parse_mode: "HTML" }); ok++; } catch { failed++; } } return ctx.reply(`Рассылка завершена: ${ok} / ошибок ${failed}`); }
      if (pending.kind === "admin_stars") { const [id, amount] = input.split(/\s+/).map(Number); if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid ${config.productName} ID or amount`); await gramsrv.grantStars(id, amount, "Telegram bot administrator grant", pending.payload.operationID); db.clearPending(ctx.from.id); return ctx.reply(`✅ Выдано ${amount} Stars → ${config.productName} ID ${id}`); }
      if (pending.kind === "admin_premium") { const [id, months] = input.split(/\s+/).map(Number); if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(months) || months <= 0) throw new Error(`invalid ${config.productName} ID or months`); await gramsrv.grantPremium(id, months, "Telegram bot administrator grant", pending.payload.operationID); db.clearPending(ctx.from.id); return ctx.reply(`✅ Premium на ${months} мес. → ${config.productName} ID ${id}`); }
      if (pending.kind === "admin_promo") { const [code, stars, limit] = input.split(/\s+/); db.createPromo(code, Number(stars), Number(limit)); db.clearPending(ctx.from.id); return ctx.reply(`✅ Промокод ${code} создан.`); }
      if (pending.kind === "admin_giveaway") { const [stars, limit, ...words] = input.split(/\s+/); const item = db.createGiveaway(words.join(" "), Number(stars), Number(limit)); db.clearPending(ctx.from.id); return ctx.reply(`🎁 ${escapeHTML(item.text)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Забрать награду", `giveaway:${item.id}`) }); }
      if (pending.kind === "admin_bonus") { const [id, amount] = input.split(/\s+/).map(Number); const balance = db.addBonus(id, amount); db.clearPending(ctx.from.id); return ctx.reply(`✅ Баланс ${id}: ${balance}`); }
      if (pending.kind === "admin_invoice") { const [idRaw, starsRaw, ...words] = input.split(/\s+/); const id = Number(idRaw), stars = Number(starsRaw), title = words.join(" "); if (!id || !stars || !title) throw new Error("invalid invoice"); await bot.api.sendInvoice(id, title, `Счёт: ${title}`, `custom|${Buffer.from(title).toString("base64url")}`, "XTR", [{ label: title, amount: stars }]); db.clearPending(ctx.from.id); return ctx.reply("✅ Счёт отправлен."); }
      if (pending.kind === "admin_access") { const [phone, telegramRaw] = input.split(/\s+/); const telegramID = Number(telegramRaw); if (!phone || !Number.isSafeInteger(telegramID) || telegramID <= 0) throw new Error("invalid phone or Telegram ID"); db.grantCodeAccess(phone, telegramID); db.clearPending(ctx.from.id); return ctx.reply(`✅ Доступ к кодам ${escapeHTML(phone)} выдан Telegram ID ${telegramID}.`, { parse_mode: "HTML" }); }
      if (pending.kind === "admin_refund") { const chargeID = input.trim(); const sale = db.saleByCharge(chargeID); if (!sale) throw new Error("sale not found for this transaction ID"); if (db.isRefunded(chargeID)) throw new Error("payment was already refunded"); await bot.api.refundStarPayment(sale.buyer_id, chargeID); db.markRefunded(chargeID, sale.buyer_id); db.clearPending(ctx.from.id); await bot.api.sendMessage(sale.buyer_id, `↩️ Оплата Telegram Stars возвращена.\n\nЧек: <code>${escapeHTML(chargeID)}</code>`, { parse_mode: "HTML" }).catch(() => {}); return ctx.reply("✅ Возврат выполнен."); }
      if (pending.kind === "admin_reply") { const [ticketRaw, ...words] = input.split(/\s+/); const ticketID = Number(ticketRaw), answer = words.join(" "); const ticket = db.supportMessage(ticketID); if (!ticket || !answer) throw new Error("ticket not found or reply is empty"); await bot.api.sendMessage(ticket.chat_id, `💬 <b>Ответ поддержки по обращению #${ticketID}</b>\n\n${escapeHTML(answer)}`, { parse_mode: "HTML" }); db.closeSupportMessage(ticketID); db.clearPending(ctx.from.id); return ctx.reply(`✅ Ответ по обращению #${ticketID} отправлен.`); }
      if (pending.kind === "admin_rate") { const rate = Number(input); if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error("invalid rate"); db.setSetting("stars_rate", rate); db.clearPending(ctx.from.id); return ctx.reply(`✅ Курс: 1⭐ = ${rate} Stars`); }
    } catch (error) { await ctx.reply(`⚠️ ${escapeHTML(error.message)}`, { parse_mode: "HTML" }); }
  });

  bot.catch(({ error, ctx }) => {
    if (error instanceof GrammyError) console.error("Telegram API error", error.description);
    else if (error instanceof HttpError) console.error("Telegram network error", error);
    else console.error(`Bot update ${ctx.update.update_id} failed`, error);
  });
  return bot;
}
