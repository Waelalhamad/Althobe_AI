function templateText(value: unknown, label: string, max: number, optional = false): string {
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) {
    throw new Error(label + ": لازم يكون نص بحد أقصى " + max + " حرف");
  }
  return value.trim();
}

export function validateTemplateName(name: unknown): string {
  if (typeof name !== "string" || !name || name.length > 512 || /[^a-z0-9_]/.test(name)) {
    throw new Error("اسم القالب لازم يكون من ١ لـ٥١٢ حرف: أحرف إنكليزية صغيرة أو أرقام أو _ بس");
  }
  return name;
}

export function buildTemplatePayload(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("بيانات القالب ناقصة");
  const fields = input as Record<string, unknown>;
  const name = validateTemplateName(fields.name);
  const language = fields.language === undefined ? "ar" : fields.language;
  if (typeof language !== "string" || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language) || /\s/.test(language)) {
    throw new Error("رمز اللغة غلط (مثلاً ar أو en_US)");
  }
  const body = templateText(fields.body, "نص الرسالة", 1024);
  const header = templateText(fields.header, "العنوان", 60, true);
  const footer = templateText(fields.footer, "التذييل", 60, true);
  const buttons = fields.buttons === undefined ? [] : fields.buttons;
  if (!Array.isArray(buttons) || buttons.length > 3) throw new Error("مسموح ٣ أزرار رد سريع كحد أقصى");
  if (/[{}]/.test(body.replaceAll("{{1}}", ""))) throw new Error("المتغيّر الوحيد المسموح بنص الرسالة هو {{1}}");
  if (body.startsWith("{{1}}") || body.endsWith("{{1}}")) throw new Error("نص الرسالة ما فيه يبدأ أو ينتهي بـ {{1}}");
  if (/[{}]/.test(header) || /[{}]/.test(footer)) throw new Error("المتغيّرات مسموحة بنص الرسالة بس");

  const quickReplies = buttons.map((label: unknown) => {
    const text = templateText(label, "نص زر الرد السريع", 25);
    if (/[{}]/.test(text)) throw new Error("المتغيّرات مسموحة بنص الرسالة بس");
    return { type: "QUICK_REPLY", text };
  });
  // Image headers need Meta's resumable upload with an app ID; only text headers are created here.
  const components = [
    ...(header ? [{ type: "HEADER", format: "TEXT", text: header }] : []),
    { type: "BODY", text: body, ...(body.includes("{{1}}") ? { example: { body_text: [["محمد"]] } } : {}) },
    ...(footer ? [{ type: "FOOTER", text: footer }] : []),
    ...(quickReplies.length ? [{ type: "BUTTONS", buttons: quickReplies }] : []),
  ];
  return { name, language, category: "MARKETING", components };
}
