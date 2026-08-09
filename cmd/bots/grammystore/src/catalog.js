export const KINDS = Object.freeze({ premium: "premium", stars: "stars", number: "number", username: "username" });

const fixed = Object.freeze([
  { kind: KINDS.premium, code: "premium_1m", title: "NexGram Premium — 1 месяц", description: "Премиум-подписка на 1 месяц", starsPrice: 20, months: 1 },
  { kind: KINDS.premium, code: "premium_3m", title: "NexGram Premium — 3 месяца", description: "Премиум-подписка на 3 месяца", starsPrice: 40, months: 3 },
  { kind: KINDS.number, code: "num_short", title: "Анонимный номер +888 8 XXX", description: "Формат +888 8 XXX (3 случайные цифры)", starsPrice: 50, numberFormat: "short" },
  { kind: KINDS.number, code: "num_long", title: "Анонимный номер +888 0XXX XXXX", description: "Формат +888 0XXX XXXX (7 случайных цифр)", starsPrice: 25, numberFormat: "long" },
  { kind: KINDS.username, code: "uname_10", title: "Коллекционный @username — ставка 10 TON", description: "Выпуск NFT-юзернейма в NexGram со ставкой 10 TON.", starsPrice: 10, bid: 10 },
  { kind: KINDS.username, code: "uname_100", title: "Коллекционный @username — ставка 100 TON", description: "Выпуск NFT-юзернейма в NexGram со ставкой 100 TON.", starsPrice: 20, bid: 100 },
  { kind: KINDS.username, code: "uname_1000", title: "Коллекционный @username — ставка 1000 TON", description: "Выпуск NFT-юзернейма в NexGram со ставкой 1000 TON.", starsPrice: 40, bid: 1000 },
]);

export function catalog(starsRate = 20) {
  const starPackages = [1, 5, 10, 25, 50, 100].map((price) => ({
    kind: KINDS.stars,
    code: `stars_${price}`,
    title: `${price * starsRate} NexGram Stars`,
    description: `${price * starsRate} NexGram Stars за ${price} Telegram Stars`,
    starsPrice: price,
    starsAmount: price * starsRate,
  }));
  return [...fixed, ...starPackages];
}

export function findProduct(code, starsRate = 20) {
  const fixedProduct = catalog(starsRate).find((product) => product.code === code);
  if (fixedProduct) return fixedProduct;
  const match = String(code).match(/^stars_([1-9]\d{0,5})$/);
  if (!match) return null;
  const starsPrice = Number(match[1]);
  if (starsPrice > 100000) return null;
  return {
    kind: KINDS.stars,
    code: `stars_${starsPrice}`,
    title: `${starsPrice * starsRate} NexGram Stars`,
    description: `${starsPrice * starsRate} NexGram Stars за ${starsPrice} Telegram Stars`,
    starsPrice,
    starsAmount: starsPrice * starsRate,
  };
}

export function productsOfKind(kind, starsRate = 20) {
  return catalog(starsRate).filter((product) => product.kind === kind);
}

export function normalizeUsername(value) {
  const username = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(username) ? username : "";
}

export function buildPayload(productCode, targetUserID = 0, extra = "") {
  const encoded = Buffer.from(extra, "utf8").toString("base64url");
  return `store|${productCode}|${targetUserID}|${encoded}`;
}

export function parsePayload(payload) {
  const [scope, code, target, encoded = ""] = String(payload).split("|", 4);
  const targetUserID = Number(target);
  if (scope !== "store" || !code || !Number.isSafeInteger(targetUserID) || targetUserID < 0) throw new Error("invalid invoice payload");
  return { code, targetUserID, extra: Buffer.from(encoded, "base64url").toString("utf8") };
}
