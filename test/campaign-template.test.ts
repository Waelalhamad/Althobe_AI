import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTemplatePayload } from "../src/campaignTemplate.ts";

const input = { name: "winter_offer_2", body: "أهلين، عنا عرض جديد اليوم!" };

test("template names allow only lowercase letters, digits and underscores, up to 512 characters", () => {
  for (const name of ["", "Winter_offer", "winter-offer", "winter offer", "offer\n", "عرض", "a".repeat(513), 123]) {
    assert.throws(() => buildTemplatePayload({ ...input, name }), /اسم القالب/);
  }
  assert.equal(buildTemplatePayload({ ...input, name: "a".repeat(512) }).name.length, 512);
  assert.deepEqual(buildTemplatePayload(input), {
    name: input.name, language: "ar", category: "MARKETING", components: [{ type: "BODY", text: input.body }],
  });
});

test("template payload supplies the first-name example and optional components", () => {
  const body = "أهلين {{1}}، عنا عرض جديد اليوم!";
  assert.deepEqual(buildTemplatePayload({ ...input, body, language: "en_US", header: "عرض الشتوية", footer: "لفترة محدودة", buttons: ["إيه ابعتلي الصور"] }), {
    name: input.name, language: "en_US", category: "MARKETING", components: [
      { type: "HEADER", format: "TEXT", text: "عرض الشتوية" },
      { type: "BODY", text: body, example: { body_text: [["محمد"]] } },
      { type: "FOOTER", text: "لفترة محدودة" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "إيه ابعتلي الصور" }] },
    ],
  });
});

test("template body rejects variables at the start or end, and anything other than {{1}}", () => {
  for (const body of ["  {{1}} أهلين!", "أهلين {{1}}\n", "{{1}} "]) {
    assert.throws(() => buildTemplatePayload({ ...input, body }), /يبدأ أو ينتهي/);
  }
  for (const body of ["أهلين {{2}}!", "أهلين {{name}}!", "أهلين {{ 1 }}!"]) {
    assert.throws(() => buildTemplatePayload({ ...input, body }), /المتغيّر الوحيد/);
  }
});

test("template quick replies are limited to three buttons and 25 characters each", () => {
  const buttons = ["إيه ابعتلي الصور", "إيقاف العروض", "ا".repeat(25)];
  assert.equal(buildTemplatePayload({ ...input, buttons }).components.at(-1)?.buttons?.length, 3);
  assert.throws(() => buildTemplatePayload({ ...input, buttons: [...buttons, "رد رابع"] }), /٣ أزرار/);
  assert.throws(() => buildTemplatePayload({ ...input, buttons: ["ا".repeat(26)] }), /25 حرف/);
});

test("template text fields enforce their own limits and variables are body-only", () => {
  assert.throws(() => buildTemplatePayload({ ...input, body: "ا".repeat(1025) }), /1024 حرف/);
  assert.throws(() => buildTemplatePayload({ ...input, header: "ا".repeat(61) }), /60 حرف/);
  assert.throws(() => buildTemplatePayload({ ...input, footer: "ا".repeat(61) }), /60 حرف/);
  assert.throws(() => buildTemplatePayload({ ...input, header: "أهلين {{1}}!" }), /بنص الرسالة بس/);
});
