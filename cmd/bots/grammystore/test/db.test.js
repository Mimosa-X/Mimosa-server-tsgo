import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BotDatabase } from "../src/db.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "telesrv-grammy-")); const db = new BotDatabase(path.join(dir, "bot.sqlite3"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); }); return db;
}

test("start user receives persistent unique number and referral bonus is idempotent", (t) => {
  const db = fixture(t);
  db.upsertUser({ id: 1, username: "owner", first_name: "Owner" }, 1, "ru");
  db.upsertUser({ id: 2, username: "guest", first_name: "Guest" }, 2, "ru", 1, 100);
  db.upsertUser({ id: 2, username: "guest", first_name: "Guest" }, 2, "ru", 1, 100);
  const first = db.createNumber(2, 2, "free", "RU", false); const same = db.createNumber(2, 2, "free", "RU", false);
  assert.equal(first.id, same.id); assert.equal(db.user(1).bonus, 100); assert.equal(db.user(1).referral_count, 1);
});

test("a paid anonymous number does not hide the persistent free number", (t) => {
  const db = fixture(t);
  db.upsertUser({ id: 7, first_name: "Buyer" }, 70, "ru");
  const free = db.createNumber(7, 70, "free", "RU", false);
  const paid = db.createNumber(7, 70, "short", "ANON", true);
  assert.notEqual(free.id, paid.id);
  assert.equal(db.freeNumber(7).id, free.id);
  assert.deepEqual(new Set(db.numbers(7).map((number) => number.id)), new Set([free.id, paid.id]));
});

test("payment charge can finish only once and failed work can retry", (t) => {
  const db = fixture(t);
  assert.equal(db.beginPayment("charge", 1, "payload", 10), true); db.failPayment("charge", "temporary");
  assert.equal(db.beginPayment("charge", 1, "payload", 10), true); db.finishPayment("charge");
  assert.equal(db.beginPayment("charge", 1, "payload", 10), false);
});

test("promo claims are transactionally unique", (t) => {
  const db = fixture(t); db.createPromo("HELLO", 50, 1);
  assert.equal(db.claimPromo("hello", 1).stars_amount, 50);
  assert.throws(() => db.claimPromo("hello", 1));
});

test("code access, support replies, refunds and pending wheel awards are durable", (t) => {
  const db = fixture(t);
  db.upsertUser({ id: 1, first_name: "Owner" }, 10, "ru");
  db.upsertUser({ id: 2, first_name: "Viewer" }, 20, "ru");
  const number = db.createNumber(1, 10, "free", "RU", false);
  db.grantCodeAccess(number.phone, 2);
  const delivery = db.updateLoginCode(number.phone, "54321");
  assert.deepEqual(new Set(delivery.chatIDs), new Set([10, 20]));
  const accepted = db.acceptLoginCodeDelivery("otp-1", "hash-1", number.phone, "12345", 2_000_000_000);
  assert.deepEqual(new Set(accepted.chatIDs), new Set([10, 20]));
  assert.equal(db.acceptLoginCodeDelivery("otp-1", "hash-1", number.phone, "12345", 2_000_000_000).duplicate, true);
  assert.throws(() => db.acceptLoginCodeDelivery("otp-1", "different", number.phone, "12345", 2_000_000_000));

  const ticket = db.addSupportMessage(1, 10, "help");
  assert.equal(db.supportMessage(ticket).status, "open");
  db.closeSupportMessage(ticket);
  assert.equal(db.supportMessage(ticket).status, "answered");

  db.addSale({ product: "stars_1", title: "20 NexGram Stars", starsPrice: 1, recipientID: 100, buyerID: 1, buyerName: "Owner", chargeID: "charge-refund", fulfillment: { kind: "stars", recipientID: 100, amount: 20 } });
  assert.deepEqual(db.saleByCharge("charge-refund").fulfillment, { kind: "stars", recipientID: 100, amount: 20 });
  assert.equal(db.beginRefund("charge-refund", 1).internal_reversed, 0);
  db.markRefundInternal("charge-refund");
  db.failRefund("charge-refund", "telegram unavailable");
  assert.equal(db.refundByCharge("charge-refund").status, "internal_reversed");
  db.markRefunded("charge-refund", 1);
  assert.equal(db.isRefunded("charge-refund"), true);

  const reserved = db.reserveSpin(1, 100, 50);
  assert.equal(db.reserveSpin(1, 100, 999).prize, 50);
  db.finishSpin(1, reserved.day);
  assert.throws(() => db.reserveSpin(1, 100, 50));
});

test("refunding a paid number removes it and restores the previous number", (t) => {
  const db = fixture(t);
  db.upsertUser({ id: 5, first_name: "Buyer" }, 50, "ru");
  const free = db.createNumber(5, 50, "free", "RU", false);
  const paid = db.createNumber(5, 50, "short", "ANON", true);
  assert.equal(db.revokePurchasedNumber(5, paid.id, paid.phone), true);
  assert.equal(db.revokePurchasedNumber(5, paid.id, paid.phone), false);
  assert.equal(db.currentNumber(5).id, free.id);
  assert.equal(db.findNumber(paid.phone), null);
});
