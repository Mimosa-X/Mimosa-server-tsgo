import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { randomInt } from "node:crypto";
import { buildPayload, findProduct, KINDS, normalizeUsername, parsePayload, productsOfKind } from "./catalog.js";

const SPIN_PRIZES = Object.freeze([
  { amount: 50, weight: 250 },
  { amount: 100, weight: 130 },
  { amount: 500, weight: 50 },
  { amount: 1000, weight: 30 },
  { amount: 10000, weight: 10 },
  { amount: 15, weight: 530 },
]);

export function fulfillmentForSale(sale, starsRate = 20) {
  if (sale?.fulfillment?.kind) return sale.fulfillment;
  if (!sale) throw new Error("Покупка не найдена");
  if (sale.product === "custom") return { kind: "custom" };
  let parsed = null;
  try { if (sale.invoice_payload) parsed = parsePayload(sale.invoice_payload); } catch {}
  const product = findProduct(sale.product, starsRate);
  if (!product) throw new Error("Не удалось определить выданный товар");
  if (product.kind === KINDS.stars) {
    const titleAmount = Number(String(sale.title).match(/^(\d+)\s+NexGram Stars$/)?.[1] ?? 0);
    const amount = parsed?.starsAmount || titleAmount || product.starsAmount;
    return { kind: "stars", recipientID: sale.recipient_id, amount };
  }
  if (product.kind === KINDS.premium) return { kind: "premium", recipientID: sale.recipient_id, months: product.months, entitlementID: 0 };
  if (product.kind === KINDS.username) return { kind: "username", recipientID: sale.recipient_id, username: normalizeUsername(parsed?.extra), bid: product.bid };
  throw new Error("Для старой покупки номера нет точных данных; требуется ручная проверка");
}

export async function reverseSaleFulfillment(sale, db, gramsrv) {
  const item = fulfillmentForSale(sale, db.starsRate());
  const key = `refund:${sale.charge_id}:${item.kind}`;
  if (item.kind === "custom") return item;
  if (item.kind === "stars") await gramsrv.debitStars(item.recipientID, item.amount, "Telegram bot refund", key);
  else if (item.kind === "premium") {
    if (!positiveInteger(item.entitlementID)) throw new Error("У старой Premium-покупки нет ID выдачи; автоматический отзыв небезопасен");
    await gramsrv.revokePremium(item.recipientID, item.entitlementID, "Telegram bot refund", key);
  } else if (item.kind === "username") {
    if (!item.username) throw new Error("У покупки не сохранён @username");
    await gramsrv.revokeUsername(item.username, item.recipientID, key);
  } else if (item.kind === "number") {
    if (!positiveInteger(item.numberID) || !item.phone) throw new Error("У покупки не сохранены данные номера");
    // Deletion is deliberately idempotent: a process may stop after deleting
    // the number but before persisting the refund phase.
    db.revokePurchasedNumber(item.ownerID, item.numberID, item.phone);
  } else throw new Error("Неизвестный тип выдачи");
  return item;
}

export async function executeCompensatedRefund({ sale, telegramID, db, gramsrv, refundStarPayment }) {
  const chargeID = sale.charge_id;
  const refund = db.beginRefund(chargeID, telegramID);
  try {
    if (!refund.internal_reversed) {
      await reverseSaleFulfillment(sale, db, gramsrv);
      db.markRefundInternal(chargeID);
    }
    try { await refundStarPayment(telegramID, chargeID); }
    catch (error) {
      if (!/REFUND.*ALREADY|ALREADY.*REFUND/i.test(String(error?.description ?? error?.message ?? error))) throw error;
    }
    db.markRefunded(chargeID, telegramID);
  } catch (error) {
    db.failRefund(chargeID, error.message);
    throw error;
  }
}

const FREE_COUNTRY_TEXT = "🎁 <b>Бесплатный номер</b>\n\nВыберите код страны для получения бесплатного номера.\nНа этот номер вы сможете получать коды входа <b>бесплатно</b>.";
const ID_HELP_TEXT = "ℹ️ <b>Как получить свой NexGram ID</b>\n\n1. Перейдите в бот <b>@getmyid</b> (именно в <b>NexGram</b>, не в Telegram!)\n2. Нажмите «Старт»\n3. Скопируйте свой ID\n4. Пришлите его сюда сообщением";

function escapeHTML(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function isOwner(config, userID) { return config.ownerIDs.has(userID); }
function displayName(from) { return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(" "); }
function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : 0;
}
function normalizePhone(value) {
  const phone = String(value ?? "").replace(/[\s()\-]/g, "");
  return phone && !phone.startsWith("+") ? `+${phone}` : phone;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function menuText(config, userID) {
  let value = `👋 Привет! Это бот <b>${escapeHTML(config.productName)}</b>.\n\nВыбери действие кнопками ниже 👇`;
  if (isOwner(config, userID)) value += "\n\n👑 <i>Режим владельца: покупки проходят без счёта, автоматически.</i>";
  return value;
}

function mainKeyboard(admin) {
  const keyboard = new InlineKeyboard()
    .text("🛍 Магазин", "shop").row()
    .text("📞 Мои номера", "mynumbers").row()
    .text("🎁 Бесплатный номер", "free").row()
    .text("🎰 Бесплатная рулетка", "spin").row()
    .text("🆔 Как узнать свой NexGram ID", "idhelp");
  if (admin) keyboard.row().text("👑 Админка", "admin");
  return keyboard;
}

function backMenuKeyboard() { return new InlineKeyboard().text("⬅️ В меню", "menu"); }
function shopKeyboard() {
  return new InlineKeyboard()
    .text("💎 Premium", "cat:premium").row()
    .text("⭐ NexGram Stars", "cat:stars").row()
    .text("📞 Номера +888", "cat:number").row()
    .text("🎭 Коллекционные @username", "cat:username").row()
    .text("⬅️ Назад", "menu");
}
function freeCountryKeyboard() {
  return new InlineKeyboard().text("🇷🇺 +7 (Россия)", "free:RU").text("🇺🇸 +1 (США)", "free:US").row().text("⬅️ В меню", "menu");
}
function adminKeyboard() {
  return new InlineKeyboard()
    .text("⭐ Выдать Stars", "adm:stars").row()
    .text("💎 Выдать Premium", "adm:premium").row()
    .text("🎭 Выдать @username", "adm:username").row()
    .text("🧾 Выставить счёт", "adm:invoice").row()
    .text("📨 Дать доступ к кодам", "adm:access").row()
    .text("📢 Рассылка", "adm:bcast").row()
    .text("🎉 Акция", "adm:gw").row()
    .text("🏷 Промокод", "adm:promo").row()
    .text("💱 Курс NexGram Stars", "adm:rate").row()
    .text("↩️ Возврат по transaction ID", "adm:refund").row()
    .text("📒 Логи магазина", "adm:sales").row()
    .text("⬅️ В меню", "menu");
}
function categoryKeyboard(kind, db) {
  const keyboard = new InlineKeyboard();
  for (const product of productsOfKind(kind, db.starsRate())) {
    let label = `${product.title} — ${product.starsPrice}⭐`;
    if (product.kind === KINDS.premium) label = `${product.months} мес — ${product.starsPrice}⭐`;
    if (product.kind === KINDS.username) label = `Ставка ${product.bid} TON — ${product.starsPrice}⭐`;
    keyboard.text(label, `p:${product.code}`).row();
  }
  return keyboard.text("⬅️ Назад", "shop");
}
function productKeyboard(product) {
  const keyboard = new InlineKeyboard().text("🛒 Купить", `buy:${product.code}:self`);
  if (product.kind !== KINDS.number && product.kind !== KINDS.username) keyboard.row().text("🎁 Купить другому", `buy:${product.code}:other`);
  return keyboard.row().text("⬅️ Назад", `cat:${product.kind}`);
}
function targetKeyboard(productCode, buyerID, db) {
  const keyboard = new InlineKeyboard();
  for (const recipientID of db.recentRecipients(buyerID)) keyboard.text(`♻️ ${recipientID}`, `rid:${productCode}:${recipientID}`).row();
  return keyboard.text("⬅️ В меню", "menu");
}
function productText(product, db) {
  let extra = "";
  if (product.kind === KINDS.stars) extra = `\n\nКурс: 1⭐ Telegram = ${db.starsRate()} NexGram Stars`;
  if (product.kind === KINDS.number) extra = "\n\nПосле оплаты номер резервируется за тобой, коды авторизации приходят в этот чат.";
  if (product.kind === KINDS.username) extra = `\n\nСтавка: <b>${product.bid} TON</b>. После оплаты юзернейм будет выпущен как коллекционный NFT в NexGram и закреплён за указанным NexGram ID.`;
  return `<b>${escapeHTML(product.title)}</b>\n\n${escapeHTML(product.description)}\n\n💰 Цена: <b>${product.starsPrice} ⭐</b>${extra}`;
}

async function editOrReply(ctx, text, keyboard = backMenuKeyboard()) {
  const options = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard };
  if (ctx.callbackQuery?.message) {
    try { return await ctx.editMessageText(text, options); }
    catch (error) {
      if (String(error?.description ?? error).includes("message is not modified")) return;
    }
  }
  return ctx.reply(text, options);
}

async function isSubscribed(ctx, config) {
  if (!config.requiredChannel || isOwner(config, ctx.from.id)) return true;
  try {
    const member = await ctx.api.getChatMember(config.requiredChannel, ctx.from.id);
    return ["creator", "administrator", "member", "restricted"].includes(member.status);
  } catch (error) {
    console.error("subscription check failed", ctx.from.id, error?.description ?? error);
    return false;
  }
}

function subscriptionKeyboard(config) {
  const keyboard = new InlineKeyboard();
  const url = config.requiredChannelURL || `https://t.me/${config.requiredChannel.replace(/^@/, "")}`;
  if (url) keyboard.url("📣 Открыть канал", url).row();
  return keyboard.text("✅ Я подписался", "checksub");
}
function subscriptionText(config) {
  return `🔒 <b>Подпишись на канал</b> ${escapeHTML(config.requiredChannel)}\n\nДля работы с ботом нужна подписка на наш канал.\n1. Подпишись на ${escapeHTML(config.requiredChannel)}\n2. Нажми «✅ Я подписался»`;
}
async function requireSubscription(ctx, config) {
  if (await isSubscribed(ctx, config)) return true;
  await editOrReply(ctx, subscriptionText(config), subscriptionKeyboard(config));
  return false;
}

function rollPrize() {
  let value = randomInt(SPIN_PRIZES.reduce((sum, prize) => sum + prize.weight, 0));
  for (const prize of SPIN_PRIZES) {
    value -= prize.weight;
    if (value < 0) return prize.amount;
  }
  return 15;
}

export function createBot({ config, db, gramsrv }) {
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat) db.upsertUser(ctx.from, ctx.chat.id, "ru");
    await next();
  });

  async function showMenu(ctx) {
    db.clearPending(ctx.from.id);
    return editOrReply(ctx, menuText(config, ctx.from.id), mainKeyboard(isOwner(config, ctx.from.id)));
  }

  async function broadcast(text, keyboard) {
    let sent = 0, failed = 0;
    for (const user of db.users()) {
      try {
        await bot.api.sendMessage(user.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
        sent++;
      } catch { failed++; }
      await sleep(40);
    }
    return { sent, failed };
  }

  async function fulfill(product, recipientID, buyer, chatID, chargeID, extra = "") {
    if (db.saleByCharge(chargeID)) return;
    const commandKey = `payment:${chargeID}:${product.code}`;
    let number, fulfillment;
    if (product.kind === KINDS.premium) {
      if (!positiveInteger(recipientID)) throw new Error("Некорректный NexGram ID получателя");
      const result = await gramsrv.grantPremium(recipientID, product.months, "Telegram bot purchase", commandKey);
      fulfillment = { kind: "premium", recipientID, months: product.months, entitlementID: Number(result?.details?.entitlement_id ?? 0) };
    } else if (product.kind === KINDS.stars) {
      if (!positiveInteger(recipientID)) throw new Error("Некорректный NexGram ID получателя");
      await gramsrv.grantStars(recipientID, product.starsAmount, "Telegram bot purchase", commandKey);
      fulfillment = { kind: "stars", recipientID, amount: product.starsAmount };
    } else if (product.kind === KINDS.username) {
      const username = normalizeUsername(extra);
      if (!positiveInteger(recipientID) || !username) throw new Error("Некорректный NexGram ID или @username");
      await gramsrv.mintUsername(recipientID, username, product.bid, commandKey);
      fulfillment = { kind: "username", recipientID, username, bid: product.bid };
    } else if (product.kind === KINDS.number) {
      number = db.createNumber(buyer.id, chatID, product.numberFormat, "ANON", true);
      recipientID = buyer.id;
      fulfillment = { kind: "number", ownerID: buyer.id, numberID: number.id, phone: number.phone, format: number.format };
    } else throw new Error("Неизвестный товар");

    db.addSale({ product: product.code, title: product.title, starsPrice: product.starsPrice, recipientID, buyerID: buyer.id, buyerName: displayName(buyer), chargeID, fulfillment });
    if (number) {
      await bot.api.sendMessage(chatID, `✅ <b>Номер зарезервирован</b>\n\n📞 <code>${escapeHTML(number.display)}</code>\n\nКоды авторизации будут приходить сюда.`, { parse_mode: "HTML", reply_markup: backMenuKeyboard() });
    } else if (product.kind === KINDS.username) {
      const username = normalizeUsername(extra);
      await bot.api.sendMessage(chatID, `✅ <b>Коллекционный @${escapeHTML(username)} выдан</b>\n\nВладелец: <code>${recipientID}</code>\nСтавка: <b>${product.bid} TON</b>\n\n🔗 ${escapeHTML(config.publicBaseURL)}/nft/username/${escapeHTML(username)}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: backMenuKeyboard() });
    } else {
      const result = product.kind === KINDS.premium ? `Premium на ${product.months} мес.` : `${product.starsAmount} NexGram Stars`;
      await bot.api.sendMessage(chatID, `✅ ${result} выдано пользователю <code>${recipientID}</code>`, { parse_mode: "HTML", reply_markup: backMenuKeyboard() });
    }
  }

  async function startPurchase(ctx, product, targetID = 0, extra = "") {
    if (targetID > 0 && targetID !== ctx.from.id) db.rememberRecipient(ctx.from.id, targetID);
    if (isOwner(config, ctx.from.id)) {
      await ctx.reply(`👑 <b>Тестовая покупка без оплаты</b>\n\n${escapeHTML(product.title)}\n(${product.starsPrice} ⭐ списано не будет)`, { parse_mode: "HTML" });
      return fulfill(product, targetID || ctx.from.id, ctx.from, ctx.chat.id, `owner-${ctx.from.id}-${Date.now()}-${randomInt(1_000_000)}`, extra);
    }
    const starsAmount = product.kind === KINDS.stars ? product.starsAmount : 0;
    await ctx.api.sendInvoice(ctx.chat.id, product.title, product.description, buildPayload(product.code, targetID, extra, starsAmount), "XTR", [{ label: product.title, amount: product.starsPrice }]);
  }

  bot.command(["start", "menu", "shop"], async (ctx) => {
    db.clearPending(ctx.from.id);
    if (!(await requireSubscription(ctx, config))) return;
    const free = db.freeNumber(ctx.from.id);
    if (!free) return editOrReply(ctx, `${menuText(config, ctx.from.id)}\n\n${FREE_COUNTRY_TEXT}`, freeCountryKeyboard());
    return showMenu(ctx);
  });

  bot.command("promo_code", async (ctx) => {
    if (!(await requireSubscription(ctx, config))) return;
    const code = String(ctx.match ?? "").trim().split(/\s+/)[0];
    if (!code) return ctx.reply("Формат: <code>/promo_code КОД</code>", { parse_mode: "HTML" });
    db.setPending(ctx.from.id, "promo_claim", { code: code.toLowerCase() });
    return ctx.reply(`🏷 Пришли свой <b>NexGram ID</b> сообщением.\n\n${ID_HELP_TEXT}`, { parse_mode: "HTML", reply_markup: backMenuKeyboard() });
  });

  bot.on("pre_checkout_query", async (ctx) => {
    try {
      const query = ctx.preCheckoutQuery;
      if (query.currency !== "XTR") throw new Error("unsupported currency");
      if (!query.invoice_payload.startsWith("custom|")) {
        const parsed = parsePayload(query.invoice_payload);
        const product = findProduct(parsed.code, db.starsRate());
        if (!product || product.starsPrice !== query.total_amount || (product.kind === KINDS.stars && parsed.starsAmount <= 0)) throw new Error("stale invoice");
      }
      await ctx.answerPreCheckoutQuery(true);
    } catch {
      await ctx.answerPreCheckoutQuery(false, { error_message: "Некорректный или устаревший заказ." });
    }
  });

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const chargeID = payment.telegram_payment_charge_id;
    if (!db.beginPayment(chargeID, ctx.from.id, payment.invoice_payload, payment.total_amount)) return;
    try {
      if (payment.invoice_payload.startsWith("custom|")) {
        const title = Buffer.from(payment.invoice_payload.slice(7), "base64url").toString("utf8");
        db.addSale({ product: "custom", title, starsPrice: payment.total_amount, recipientID: ctx.from.id, buyerID: ctx.from.id, buyerName: displayName(ctx.from), chargeID, fulfillment: { kind: "custom" } });
        await ctx.reply(`✅ <b>Оплата получена</b>\n\n${escapeHTML(title)} — ${payment.total_amount} ⭐\n\nЧек: <code>${escapeHTML(chargeID)}</code>`, { parse_mode: "HTML" });
        for (const ownerID of config.ownerIDs) await bot.api.sendMessage(ownerID, `💰 Счёт оплачен: <code>${ctx.from.id}</code> → ${escapeHTML(title)} (${payment.total_amount} ⭐)`, { parse_mode: "HTML" }).catch(() => {});
      } else {
        const parsed = parsePayload(payment.invoice_payload);
        let product = findProduct(parsed.code, db.starsRate());
        if (!product || payment.currency !== "XTR" || payment.total_amount !== product.starsPrice) throw new Error("Параметры оплаченного товара изменились");
        if (product.kind === KINDS.stars) {
          if (parsed.starsAmount <= 0) throw new Error("В счёте не зафиксировано количество NexGram Stars");
          product = { ...product, starsAmount: parsed.starsAmount, title: `${parsed.starsAmount} NexGram Stars` };
        }
        await fulfill(product, parsed.targetUserID || ctx.from.id, ctx.from, ctx.chat.id, chargeID, parsed.extra);
      }
      db.finishPayment(chargeID);
    } catch (error) {
      db.failPayment(chargeID, error.message);
      await ctx.reply(`⚠️ Оплата прошла, но автоматическая выдача не завершена. Передайте поддержке чек <code>${escapeHTML(chargeID)}</code>.`, { parse_mode: "HTML" });
      for (const ownerID of config.ownerIDs) await bot.api.sendMessage(ownerID, `⚠️ Ошибка выдачи <code>${escapeHTML(chargeID)}</code>: ${escapeHTML(error.message)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    if (data === "checksub") {
      if (await isSubscribed(ctx, config)) return showMenu(ctx);
      return editOrReply(ctx, subscriptionText(config), subscriptionKeyboard(config));
    }
    if (!(await requireSubscription(ctx, config))) return;

    if (data === "menu") return showMenu(ctx);
    if (data === "shop") { db.clearPending(ctx.from.id); return editOrReply(ctx, "🛍 <b>NexGram Shop</b>\n\nВыбери категорию:", shopKeyboard()); }
    if (data === "idhelp") return editOrReply(ctx, ID_HELP_TEXT, backMenuKeyboard());
    if (data === "free") {
      const number = db.freeNumber(ctx.from.id);
      return number
        ? editOrReply(ctx, `🎁 У вас уже есть бесплатный номер:\n\n📞 <code>${escapeHTML(number.display)}</code>\n\nКоды приходят в этот чат.`, backMenuKeyboard())
        : editOrReply(ctx, FREE_COUNTRY_TEXT, freeCountryKeyboard());
    }
    if (/^free:(RU|US)$/.test(data)) {
      const country = data.slice(5);
      const existing = db.freeNumber(ctx.from.id);
      const number = existing ?? db.createNumber(ctx.from.id, ctx.chat.id, "free", country, false);
      return editOrReply(ctx, `✅ <b>Ваш бесплатный номер</b>\n\n📞 <code>${escapeHTML(number.display)}</code>\n\nКоды авторизации на этот номер приходят сюда <b>бесплатно</b>.`, backMenuKeyboard());
    }
    if (data === "mynumbers") {
      const numbers = db.numbers(ctx.from.id);
      if (!numbers.length) return editOrReply(ctx, "У тебя пока нет номеров.", shopKeyboard());
      const lines = numbers.map((number, index) => `${index + 1}. <code>${escapeHTML(number.display)}</code>${number.format === "free" ? " 🎁 <i>бесплатный</i>" : ""}`);
      return editOrReply(ctx, `<b>📞 Твои номера:</b>\n\n${lines.join("\n")}`, backMenuKeyboard());
    }
    if (data === "spin") {
      db.setPending(ctx.from.id, "spin_id");
      return editOrReply(ctx, `🎰 <b>Бесплатная рулетка</b>\n\nУсловия:\n• 1 спин в день, максимум 5 в неделю\n\nПризы (NexGram Stars): 15 / 50 / 100 / 500 / 1000 / 10000\n\n🆔 Пришли свой <b>NexGram ID</b> сообщением, чтобы крутить.\n\n${ID_HELP_TEXT}`, backMenuKeyboard());
    }

    if (data === "admin") {
      if (!isOwner(config, ctx.from.id)) return;
      db.clearPending(ctx.from.id);
      return editOrReply(ctx, "👑 <b>Админка</b>\n\nВыберите действие:", adminKeyboard());
    }
    if (data === "adm:sales") {
      if (!isOwner(config, ctx.from.id)) return;
      const lines = db.recentSales(20).map((sale) => `• ${new Date(sale.created_at * 1000).toISOString().slice(0, 16).replace("T", " ")} — <b>${escapeHTML(sale.title)}</b> (${sale.stars_price}⭐) → <code>${sale.recipient_id}</code> (от <code>${sale.buyer_id}</code>)`);
      return editOrReply(ctx, lines.length ? `<b>📒 Последние продажи:</b>\n\n${lines.join("\n")}` : "📒 Логи магазина пусты.", backMenuKeyboard());
    }
    if (data.startsWith("adm:")) {
      if (!isOwner(config, ctx.from.id)) return;
      const action = data.slice(4);
      const prompts = {
        stars: ["give_stars", "⭐ <b>Выдача NexGram Stars</b>\n\nПришли: <code>nexgram_id количество</code>"],
        premium: ["give_premium", "💎 <b>Выдача Premium</b>\n\nПришли: <code>nexgram_id месяцы</code>"],
        username: ["give_username", "🎭 <b>Выдача коллекционного @username</b>\n\nПришли: <code>nexgram_id username ставка_TON</code>"],
        invoice: ["adm_invoice", "🧾 <b>Выставить счёт</b>\n\nПришли: <code>telegram_id сумма_звёзд название</code>"],
        refund: ["adm_refund", "↩️ <b>Возврат Telegram Stars</b>\n\nПришли <code>transaction_id</code> или <code>telegram_id transaction_id</code>."],
        access: ["give_access", "📨 <b>Доступ к кодам</b>\n\nПришли: <code>номер telegram_id</code>"],
        bcast: ["bcast_text", `📢 <b>Рассылка</b>\n\nПришли текст одним сообщением (HTML разрешён).\nПолучателей: <b>${db.users().length}</b>`],
        gw: ["gw_text", "🎉 <b>Новая акция</b>\n\nШаг 1/3. Пришли текст акции (HTML разрешён)."],
        promo: ["promo_new", "🏷 <b>Новый промокод</b>\n\nПришли: <code>код количество_stars макс_активаций</code>"],
        rate: ["rate_set", `💱 <b>Курс NexGram Stars</b>\n\nТекущий: 1⭐ = <b>${db.starsRate()}</b> NexGram Stars.\n\nПришли новое число.`],
      };
      if (!prompts[action]) return;
      db.setPending(ctx.from.id, prompts[action][0], { operationID: `admin:${ctx.from.id}:${Date.now()}:${randomInt(1_000_000)}` });
      return editOrReply(ctx, prompts[action][1], backMenuKeyboard());
    }

    if (data.startsWith("cat:")) {
      db.clearPending(ctx.from.id);
      const kind = data.slice(4);
      if (kind === KINDS.stars) {
        db.setPending(ctx.from.id, "stars_amount");
        const rate = db.starsRate();
        return editOrReply(ctx, `⭐ <b>Покупка NexGram Stars</b>\n\nАктуальный курс: <b>1⭐ Telegram = ${rate} NexGram Stars</b>\n\nСколько <b>Telegram Stars</b> вы хотите потратить? Пришли число сообщением.\n\nНапример: <code>100</code> → получите ${100 * rate} NexGram Stars.`, backMenuKeyboard());
      }
      const titles = { premium: "💎 <b>NexGram Premium</b>\n\nВыбери срок:", number: "📞 <b>Анонимные номера +888</b>\n\nВыбери формат:", username: "🎭 <b>Коллекционные @username</b>\n\nВыбери ставку:" };
      return titles[kind] ? editOrReply(ctx, titles[kind], categoryKeyboard(kind, db)) : editOrReply(ctx, "Категория не найдена.", shopKeyboard());
    }
    if (data.startsWith("p:")) {
      db.clearPending(ctx.from.id);
      const product = findProduct(data.slice(2), db.starsRate());
      return product ? editOrReply(ctx, productText(product, db), productKeyboard(product)) : editOrReply(ctx, "Товар не найден.", shopKeyboard());
    }
    if (data.startsWith("buy:")) {
      const [, code, targetMode] = data.split(":");
      const product = findProduct(code, db.starsRate());
      if (!product) return editOrReply(ctx, "Товар не найден.", shopKeyboard());
      if (product.kind === KINDS.username) {
        db.setPending(ctx.from.id, "username_input", { productCode: code });
        return editOrReply(ctx, `<b>${escapeHTML(product.title)}</b>\n\n🎭 Пришли желаемый <b>@username</b> сообщением (5–32 символа, латиница/цифры/подчёркивание).\n\nПотом попросим <b>NexGram ID</b> получателя.`, backMenuKeyboard());
      }
      if ([KINDS.premium, KINDS.stars].includes(product.kind) || targetMode === "other") {
        db.setPending(ctx.from.id, "target_id", { productCode: code });
        return editOrReply(ctx, `<b>${escapeHTML(product.title)}</b>\n\n🆔 <b>Введите NexGram ID</b> получателя (свой или друга) — сообщением, до оплаты.\n\nИли выберите недавний ID.\n\n${ID_HELP_TEXT}`, targetKeyboard(code, ctx.from.id, db));
      }
      return startPurchase(ctx, product);
    }
    if (data.startsWith("rid:")) {
      const [, code, rawID] = data.split(":");
      const recipientID = positiveInteger(rawID);
      const product = findProduct(code, db.starsRate());
      if (!recipientID || !product) return;
      db.clearPending(ctx.from.id);
      return startPurchase(ctx, product, recipientID);
    }
    if (data.startsWith("gw:")) {
      const giveawayID = data.slice(3);
      db.setPending(ctx.from.id, "gw_claim", { giveawayID });
      return ctx.reply(`🎁 <b>Получение награды</b>\n\nПришли свой <b>NexGram ID</b> сообщением.\n\n${ID_HELP_TEXT}`, { parse_mode: "HTML", reply_markup: backMenuKeyboard() });
    }
  });

  bot.on("message:text", async (ctx) => {
    const input = ctx.message.text.trim();
    if (input.startsWith("/")) return;
    if (!(await requireSubscription(ctx, config))) return;

    if (/^!(промокод|promo)\s+/i.test(input)) {
      const code = input.split(/\s+/)[1]?.toLowerCase();
      if (!code) return ctx.reply("Формат: <code>!промокод КОД</code>", { parse_mode: "HTML" });
      db.setPending(ctx.from.id, "promo_claim", { code });
      return ctx.reply(`🏷 Пришли свой <b>NexGram ID</b> сообщением.\n\n${ID_HELP_TEXT}`, { parse_mode: "HTML", reply_markup: backMenuKeyboard() });
    }

    const pending = db.pending(ctx.from.id);
    if (!pending) return showMenu(ctx);
    const keep = async (message, keyboard = backMenuKeyboard()) => ctx.reply(message, { parse_mode: "HTML", reply_markup: keyboard });

    try {
      if (pending.kind === "target_id") {
        const recipientID = positiveInteger(input);
        if (!recipientID) return keep(`Неверный ID. Пришли только цифры.\n\n${ID_HELP_TEXT}`, targetKeyboard(pending.payload.productCode, ctx.from.id, db));
        const product = findProduct(pending.payload.productCode, db.starsRate());
        if (!product) throw new Error("Товар не найден");
        db.clearPending(ctx.from.id);
        return startPurchase(ctx, product, recipientID);
      }
      if (pending.kind === "stars_amount") {
        const amount = positiveInteger(input, 100000);
        if (!amount) return keep("Нужно положительное число Telegram Stars (максимум 100000). Попробуй ещё раз.");
        const code = `stars_${amount}`;
        db.setPending(ctx.from.id, "target_id", { productCode: code });
        return keep(`Отлично — счёт будет на <b>${amount} ⭐ Telegram</b>, зачислим <b>${amount * db.starsRate()} NexGram Stars</b>.\n\n🆔 Теперь пришли <b>NexGram ID</b> получателя.\n\n${ID_HELP_TEXT}`, targetKeyboard(code, ctx.from.id, db));
      }
      if (pending.kind === "username_input") {
        const username = normalizeUsername(input);
        if (!username) return keep("Некорректный @username. Разрешено 5–32 символа: латиница, цифры, подчёркивание; первый символ — буква.");
        db.setPending(ctx.from.id, "username_target", { productCode: pending.payload.productCode, username });
        return keep(`Юзернейм: <b>@${escapeHTML(username)}</b>\n\n🆔 Теперь пришли <b>NexGram ID</b> получателя.\n\n${ID_HELP_TEXT}`);
      }
      if (pending.kind === "username_target") {
        const recipientID = positiveInteger(input);
        if (!recipientID) return keep(`Неверный ID. Пришли только цифры.\n\n${ID_HELP_TEXT}`);
        const product = findProduct(pending.payload.productCode, db.starsRate());
        if (!product) throw new Error("Товар не найден");
        db.clearPending(ctx.from.id);
        return startPurchase(ctx, product, recipientID, pending.payload.username);
      }
      if (pending.kind === "spin_id") {
        const serverUserID = positiveInteger(input);
        if (!serverUserID) return keep(`Неверный ID. Пришли только цифры.\n\n${ID_HELP_TEXT}`);
        const award = db.reserveSpin(ctx.from.id, serverUserID, rollPrize());
        await gramsrv.grantStars(serverUserID, award.prize, "Free bot wheel", `spin:${ctx.from.id}:${award.day}`);
        db.finishSpin(ctx.from.id, award.day);
        db.clearPending(ctx.from.id);
        return keep(`🎰 <b>Крутим...</b>\n\n🎉 Поздравляем! Выпало <b>${award.prize} ⭐ NexGram Stars</b>\n\nНачислено на NexGram ID <code>${serverUserID}</code>.`, mainKeyboard(isOwner(config, ctx.from.id)));
      }
      if (pending.kind === "promo_claim") {
        const serverUserID = positiveInteger(input);
        if (!serverUserID) return keep(`Неверный NexGram ID.\n\n${ID_HELP_TEXT}`);
        const code = pending.payload.code;
        const promo = db.claimPromo(code, ctx.from.id);
        try { await gramsrv.grantStars(serverUserID, promo.stars_amount, `Promo ${code}`, `promo:${code}:${ctx.from.id}`); }
        catch (error) { db.releaseCampaignClaim("promo", code, ctx.from.id); throw error; }
        db.clearPending(ctx.from.id);
        return keep(`✅ Промокод активирован! Начислено <b>${promo.stars_amount} NexGram Stars</b> на ID <code>${serverUserID}</code>`, mainKeyboard(isOwner(config, ctx.from.id)));
      }
      if (pending.kind === "gw_claim") {
        const serverUserID = positiveInteger(input);
        if (!serverUserID) return keep(`Неверный NexGram ID.\n\n${ID_HELP_TEXT}`);
        const giveawayID = pending.payload.giveawayID;
        const item = db.claimGiveaway(giveawayID, ctx.from.id);
        try { await gramsrv.grantStars(serverUserID, item.stars_amount, `Giveaway ${giveawayID}`, `giveaway:${giveawayID}:${ctx.from.id}`); }
        catch (error) { db.releaseCampaignClaim("giveaway", giveawayID, ctx.from.id); throw error; }
        db.clearPending(ctx.from.id);
        return keep(`✅ Начислено <b>${item.stars_amount} NexGram Stars</b> на ID <code>${serverUserID}</code>`, mainKeyboard(isOwner(config, ctx.from.id)));
      }

      if (!isOwner(config, ctx.from.id)) return;
      const operationID = pending.payload.operationID ?? `admin:${ctx.from.id}:${Date.now()}`;
      if (pending.kind === "give_stars") {
        const [idRaw, amountRaw] = input.split(/\s+/); const id = positiveInteger(idRaw), amount = positiveInteger(amountRaw);
        if (!id || !amount) return keep("Формат: <code>nexgram_id количество</code>");
        await gramsrv.grantStars(id, amount, "Telegram bot administrator grant", operationID); db.clearPending(ctx.from.id);
        return keep(`✅ Выдано ${amount} NexGram Stars → ID <code>${id}</code>`);
      }
      if (pending.kind === "give_premium") {
        const [idRaw, monthsRaw] = input.split(/\s+/); const id = positiveInteger(idRaw), months = positiveInteger(monthsRaw, 1200);
        if (!id || !months) return keep("Формат: <code>nexgram_id месяцы</code>");
        await gramsrv.grantPremium(id, months, "Telegram bot administrator grant", operationID); db.clearPending(ctx.from.id);
        return keep(`✅ Выдан Premium на ${months} мес. → ID <code>${id}</code>`);
      }
      if (pending.kind === "give_username") {
        const [idRaw, usernameRaw, bidRaw] = input.split(/\s+/); const id = positiveInteger(idRaw), username = normalizeUsername(usernameRaw), bid = positiveInteger(bidRaw);
        if (!id || !username || !bid) return keep("Формат: <code>nexgram_id username ставка_TON</code>");
        await gramsrv.mintUsername(id, username, bid, operationID); db.clearPending(ctx.from.id);
        return keep(`✅ Выдан коллекционный @${escapeHTML(username)} (${bid} TON) → ID <code>${id}</code>`);
      }
      if (pending.kind === "adm_invoice") {
        const [telegramRaw, amountRaw, ...titleParts] = input.split(/\s+/); const telegramID = positiveInteger(telegramRaw), amount = positiveInteger(amountRaw, 100000), title = titleParts.join(" ").slice(0, 32);
        if (!telegramID || !amount || !title) return keep("Формат: <code>telegram_id сумма_звёзд название</code>");
        await bot.api.sendInvoice(telegramID, title, `Счёт на оплату: ${title}`, `custom|${Buffer.from(title).toString("base64url")}`, "XTR", [{ label: title, amount }]); db.clearPending(ctx.from.id);
        return keep(`✅ Счёт на <b>${amount} ⭐</b> отправлен пользователю <code>${telegramID}</code>`);
      }
      if (pending.kind === "adm_refund") {
        const parts = input.split(/\s+/); let telegramID, chargeID;
        let sale;
        if (parts.length === 1) { chargeID = parts[0]; sale = db.saleByCharge(chargeID); telegramID = sale?.buyer_id; }
        else if (parts.length === 2) { telegramID = positiveInteger(parts[0]); chargeID = parts[1]; }
        if (!telegramID || !chargeID) return keep("Не нашёл покупку. Пришли: <code>telegram_id transaction_id</code>");
        if (db.isRefunded(chargeID)) throw new Error("Этот платёж уже возвращён");
        sale ??= db.saleByCharge(chargeID);
        if (!sale || sale.buyer_id !== telegramID || sale.payment_status !== "done") throw new Error("Завершённая покупка или её владелец не найдены в журнале");
        await executeCompensatedRefund({ sale, telegramID, db, gramsrv, refundStarPayment: bot.api.refundStarPayment.bind(bot.api) });
        db.clearPending(ctx.from.id);
        await bot.api.sendMessage(telegramID, `↩️ Вам возвращена оплата Telegram Stars.\n\nЧек: <code>${escapeHTML(chargeID)}</code>`, { parse_mode: "HTML" }).catch(() => {});
        return keep(`✅ Возврат выполнен\n\nПользователь: <code>${telegramID}</code>\nTransaction: <code>${escapeHTML(chargeID)}</code>`);
      }
      if (pending.kind === "give_access") {
        const [phoneRaw, telegramRaw] = input.split(/\s+/); const phone = normalizePhone(phoneRaw), telegramID = positiveInteger(telegramRaw);
        if (!phone || !telegramID) return keep("Формат: <code>номер telegram_id</code>");
        db.grantCodeAccess(phone, telegramID); db.clearPending(ctx.from.id);
        await bot.api.sendMessage(telegramID, `🔔 <b>Вам выдан доступ к кодам</b>\n\nНомер: <code>${escapeHTML(phone)}</code>`, { parse_mode: "HTML" }).catch(() => {});
        return keep(`✅ Пользователь <code>${telegramID}</code> получил доступ к кодам номера <code>${escapeHTML(phone)}</code>`);
      }
      if (pending.kind === "bcast_text") {
        if (!input) return keep("Пустой текст. Пришли текст рассылки.");
        db.clearPending(ctx.from.id); await keep("📢 Рассылка стартовала…");
        void broadcast(input).then(({ sent, failed }) => bot.api.sendMessage(ctx.from.id, `📢 Рассылка завершена: ✅ ${sent}, ❌ ${failed}`).catch(() => {}));
        return;
      }
      if (pending.kind === "rate_set") {
        const rate = positiveInteger(input);
        if (!rate) return keep("Нужно положительное число.");
        db.setSetting("stars_rate", rate); db.clearPending(ctx.from.id);
        return keep(`✅ Курс обновлён: 1⭐ Telegram = <b>${rate}</b> NexGram Stars`);
      }
      if (pending.kind === "gw_text") {
        if (!input) return keep("Пришли текст акции.");
        db.setPending(ctx.from.id, "gw_max", { text: input });
        return keep("Шаг 2/3. Пришли <b>количество активаций</b> (0 = без лимита).");
      }
      if (pending.kind === "gw_max") {
        const limit = Number(input);
        if (!Number.isSafeInteger(limit) || limit < 0) return keep("Нужно целое число ≥ 0.");
        db.setPending(ctx.from.id, "gw_stars", { text: pending.payload.text, limit });
        return keep("Шаг 3/3. Пришли <b>количество NexGram Stars</b> за одну активацию.");
      }
      if (pending.kind === "gw_stars") {
        const stars = positiveInteger(input);
        if (!stars) return keep("Нужно положительное число.");
        const item = db.createGiveaway(pending.payload.text, stars, pending.payload.limit); db.clearPending(ctx.from.id);
        await keep(`✅ Акция создана (ID: <code>${item.id}</code>). Начинаю рассылку…`);
        const keyboard = new InlineKeyboard().text("🎁 Забрать награду", `gw:${item.id}`);
        void broadcast(item.text, keyboard).then(({ sent, failed }) => bot.api.sendMessage(ctx.from.id, `🎉 Акция разослана: ✅ ${sent}, ❌ ${failed}`).catch(() => {}));
        return;
      }
      if (pending.kind === "promo_new") {
        const [code, starsRaw, limitRaw] = input.split(/\s+/); const stars = positiveInteger(starsRaw), limit = Number(limitRaw);
        if (!code || !stars || !Number.isSafeInteger(limit) || limit < 0) return keep("Формат: <code>код количество_stars макс_активаций</code>");
        const promo = db.createPromo(code, stars, limit); db.clearPending(ctx.from.id);
        return keep(`✅ Промокод <code>${escapeHTML(promo.code)}</code> создан. Награда: ${promo.stars_amount} NexGram Stars, макс. активаций: ${promo.max_acts}.`);
      }
    } catch (error) {
      console.error("bot action failed", pending.kind, error);
      return keep(`⚠️ ${escapeHTML(error.message)}`);
    }
  });

  bot.catch(({ error, ctx }) => {
    if (error instanceof GrammyError) console.error("Telegram API error", error.description);
    else if (error instanceof HttpError) console.error("Telegram network error", error);
    else console.error(`Bot update ${ctx.update.update_id} failed`, error);
  });
  return bot;
}

export const internals = { escapeHTML, normalizePhone, positiveInteger, rollPrize };
