// Orders as an Excel file: downloaded from the dashboard, and sent to the Telegram group every day.
// Two sheets, right to left: the orders (one row per order) and a summary (totals, by status, city, color and size).
import ExcelJS from "exceljs";
import { config } from "./config.js";
import { latinDigits } from "./channels/whatsapp.js";
import { localDay } from "./dashboard/queries.js";
import { db, getSetting, setSetting, type OrderItem, type OrderStatus } from "./store.js";
import { log } from "./scheduler.js";
import { notifyDocument, notify } from "./telegram.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const STATUS: Record<OrderStatus, { label: string; fill: string; font: string }> = {
  new: { label: "جديد، بدو تأكيد", fill: "FFFFF4DE", font: "FF9A6400" },
  confirmed: { label: "متأكد", fill: "FFE3EEFD", font: "FF1D4F91" },
  delivered: { label: "انسلّم", fill: "FFDFF5EA", font: "FF17683F" },
  cancelled: { label: "ملغي", fill: "FFEFEFEF", font: "FF7A7A7A" },
};

const BRAND = "FF2F7F73"; // the dashboard's teal, darker for white text
const BRAND_SOFT = "FFE6F3F1";
const ZEBRA = "FFF8FAFA";
const BORDER = "FFD9E2E1";
const FONT = "Arial"; // renders Arabic well in Excel, Numbers and Google Sheets

type Row = {
  id: number;
  customer: string;
  name: string;
  phone: string;
  city: string;
  address: string;
  items: string;
  total: string;
  notes: string;
  status: OrderStatus;
  source: string;
  created_at: number;
};

export type SheetRange = { from: number; to: number; status?: OrderStatus };

// "385 دينار" / "٣٨٥" → 385; undefined when the total has no number.
function amount(total: string): number | undefined {
  const match = latinDigits(total).replace(/[,٬]/g, "").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

const localDate = (ms: number) => {
  // Excel has no time zones: write the dashboard's local time as if it were UTC.
  return new Date(ms + config.dashboard.timezoneOffsetHours * HOUR);
};

function loadOrders(range: SheetRange): Row[] {
  return db
    .prepare(
      `SELECT id, customer, name, phone, city, address, items, total, notes, status, source, created_at FROM orders
       WHERE created_at >= ? AND created_at < ? ${range.status ? "AND status = ?" : ""} ORDER BY id ASC`,
    )
    .all(...[range.from, range.to, ...(range.status ? [range.status] : [])]) as Row[];
}

const thin = { style: "thin" as const, color: { argb: BORDER } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

// Header look for `count` cells from `first` (only those: the summary has two tables side by side).
function styleHeader(row: ExcelJS.Row, first = 1, count = row.cellCount) {
  row.height = 26;
  Array.from({ length: count }, (_, n) => row.getCell(first + n)).forEach((cell) => {
    cell.font = { name: FONT, bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true, readingOrder: "rtl" };
    cell.border = box;
  });
}

// A big title and a grey line under it, across `width` columns.
function title(sheet: ExcelJS.Worksheet, width: number, text: string, sub: string) {
  sheet.mergeCells(1, 1, 1, width);
  sheet.mergeCells(2, 1, 2, width);
  const t = sheet.getCell(1, 1);
  t.value = text;
  t.font = { name: FONT, bold: true, size: 16, color: { argb: BRAND } };
  t.alignment = { vertical: "middle", horizontal: "right", readingOrder: "rtl" };
  sheet.getRow(1).height = 32;
  const s = sheet.getCell(2, 1);
  s.value = sub;
  s.font = { name: FONT, size: 10, color: { argb: "FF7A8584" } };
  s.alignment = { vertical: "middle", horizontal: "right", readingOrder: "rtl" };
  sheet.getRow(2).height = 20;
}

const itemLine = (i: OrderItem) => [i.product, i.color, i.size && `مقاس ${i.size}`].filter(Boolean).join(" · ") + ` × ${i.quantity}`;

export async function ordersWorkbook(range: SheetRange, heading = "طلبات الثوب العربي"): Promise<{ file: Buffer; count: number }> {
  const orders = loadOrders(range);
  const wb = new ExcelJS.Workbook();
  wb.creator = "الثوب العربي";
  wb.created = new Date();
  const period = !range.from
    ? "كل الطلبات"
    : localDay(range.from) === localDay(range.to - 1)
      ? localDay(range.from)
      : `من ${localDay(range.from)} لـ ${localDay(range.to - 1)}`;
  const sub = `${period}${range.status ? ` · ${STATUS[range.status].label}` : ""} · ${orders.length} طلب · طُلع ${localDay(Date.now())} ${localDate(Date.now()).toISOString().slice(11, 16)}`;

  // --- Sheet 1: the orders -------------------------------------------------------------------------
  const sheet = wb.addWorksheet("الطلبات", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 4, xSplit: 1, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const columns: { header: string; key: string; width: number }[] = [
    { header: "#", key: "id", width: 7 },
    { header: "التاريخ", key: "date", width: 17 },
    { header: "الاسم", key: "name", width: 22 },
    { header: "الرقم", key: "phone", width: 15 },
    { header: "المدينة", key: "city", width: 13 },
    { header: "العنوان", key: "address", width: 34 },
    { header: "الطلب", key: "items", width: 36 },
    { header: "القطع", key: "pieces", width: 8 },
    { header: "الإجمالي (دينار)", key: "amount", width: 14 },
    { header: "الحالة", key: "status", width: 15 },
    { header: "سجّله", key: "source", width: 11 },
    { header: "ملاحظات", key: "notes", width: 30 },
    { header: "واتساب", key: "whatsapp", width: 16 },
  ];
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  title(sheet, columns.length, heading, sub);
  styleHeader(sheet.getRow(4));
  columns.forEach((c, n) => (sheet.getCell(4, n + 1).value = c.header));

  orders.forEach((o, n) => {
    const items = JSON.parse(o.items) as OrderItem[];
    const status = STATUS[o.status] ?? STATUS.new;
    const value = amount(o.total);
    const row = sheet.addRow({
      id: o.id,
      date: localDate(o.created_at),
      name: o.name,
      phone: o.phone,
      city: o.city,
      address: o.address,
      items: items.map(itemLine).join("\n"),
      pieces: items.reduce((sum, i) => sum + i.quantity, 0),
      amount: value ?? o.total,
      status: status.label,
      source: o.source === "team" ? "الفريق" : "المساعد",
      notes: o.notes,
      whatsapp: /^\d+$/.test(o.customer) ? `+${o.customer}` : "",
    });
    row.height = Math.max(22, 16 * items.length + 6, o.address.length > 40 || o.notes.length > 40 ? 34 : 0);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = columns[col - 1]?.key;
      cell.font = { name: FONT, size: 11 };
      cell.border = box;
      cell.alignment = { vertical: "middle", horizontal: "right", wrapText: true, readingOrder: "rtl" };
      if (n % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      if (key === "id" || key === "pieces" || key === "source") cell.alignment = { ...cell.alignment, horizontal: "center" };
      if (key === "phone" || key === "whatsapp") cell.alignment = { vertical: "middle", horizontal: "center", readingOrder: "ltr" };
      if (key === "date") {
        cell.numFmt = "yyyy-mm-dd  hh:mm";
        cell.alignment = { vertical: "middle", horizontal: "center", readingOrder: "ltr" };
      }
      if (key === "amount" && typeof cell.value === "number") {
        cell.numFmt = "#,##0";
        cell.font = { name: FONT, size: 11, bold: true };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      }
      if (key === "status") {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: status.fill } };
        cell.font = { name: FONT, size: 11, bold: true, color: { argb: status.font } };
        cell.alignment = { vertical: "middle", horizontal: "center", readingOrder: "rtl" };
      }
      if (o.status === "cancelled" && key !== "status") cell.font = { ...cell.font, color: { argb: "FF9AA3A2" }, strike: key === "amount" };
    });
    // Phone numbers stay text, so Excel keeps the leading 0.
    row.getCell("phone").value = o.phone;
  });

  if (orders.length) {
    const first = 5;
    const last = 4 + orders.length;
    const total = sheet.addRow({});
    total.height = 26;
    sheet.mergeCells(total.number, 1, total.number, 7);
    total.getCell(1).value = "المجموع (بدون الملغي)";
    const kept = orders.filter((o) => o.status !== "cancelled");
    // Formulas, so the totals follow when someone edits or filters the sheet; the result shows before Excel recalculates.
    const notCancelled = `J${first}:J${last},"<>${STATUS.cancelled.label}"`;
    total.getCell("pieces").value = {
      formula: `SUMIFS(H${first}:H${last},${notCancelled})`,
      result: kept.reduce((sum, o) => sum + (JSON.parse(o.items) as OrderItem[]).reduce((s, i) => s + i.quantity, 0), 0),
    };
    total.getCell("amount").value = {
      formula: `SUMIFS(I${first}:I${last},${notCancelled})`,
      result: kept.reduce((sum, o) => sum + (amount(o.total) ?? 0), 0),
    };
    total.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: FONT, bold: true, size: 12, color: { argb: BRAND } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_SOFT } };
      cell.border = { top: { style: "medium", color: { argb: BRAND } }, bottom: thin, left: thin, right: thin };
      cell.alignment = { vertical: "middle", horizontal: "center", readingOrder: "rtl" };
    });
    total.getCell("amount").numFmt = "#,##0";
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: columns.length } };
  } else {
    sheet.mergeCells(5, 1, 5, columns.length);
    const empty = sheet.getCell(5, 1);
    empty.value = "ما في طلبات بهالفترة";
    empty.font = { name: FONT, size: 12, color: { argb: "FF7A8584" } };
    empty.alignment = { horizontal: "center", vertical: "middle", readingOrder: "rtl" };
    sheet.getRow(5).height = 32;
  }

  // --- Sheet 2: summary ----------------------------------------------------------------------------
  const summary = wb.addWorksheet("الملخص", {
    views: [{ rightToLeft: true, showGridLines: false }],
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  summary.columns = [{ width: 24 }, { width: 18 }, { width: 18 }, { width: 4 }, { width: 22 }, { width: 14 }, { width: 14 }];
  title(summary, 7, `ملخص ${heading}`, sub);

  const live = orders.filter((o) => o.status !== "cancelled");
  const pieces = (list: Row[]) => list.reduce((sum, o) => sum + (JSON.parse(o.items) as OrderItem[]).reduce((s, i) => s + i.quantity, 0), 0);
  const sales = (list: Row[]) => list.reduce((sum, o) => sum + (amount(o.total) ?? 0), 0);

  // Key numbers as cards in row 4-5.
  const kpis: [string, number, string?][] = [
    ["الطلبات", orders.length],
    ["القطع (بدون الملغي)", pieces(live)],
    ["المبيعات (دينار)", sales(live), "#,##0"],
  ];
  kpis.forEach(([label, value, fmt], n) => {
    const col = [1, 2, 3][n]!;
    const head = summary.getCell(4, col);
    head.value = label;
    head.font = { name: FONT, size: 10, color: { argb: "FF5E6B6A" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_SOFT } };
    head.alignment = { horizontal: "center", vertical: "middle", wrapText: true, readingOrder: "rtl" };
    const cell = summary.getCell(5, col);
    cell.value = value;
    cell.numFmt = fmt ?? "0";
    cell.font = { name: FONT, size: 18, bold: true, color: { argb: BRAND } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_SOFT } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    for (const c of [head, cell]) c.border = box;
  });
  summary.getRow(4).height = 24;
  summary.getRow(5).height = 36;

  // Small tables: [label, orders, pieces] grouped by something.
  const table = (top: number, left: number, header: string, groups: Map<string, { orders: number; pieces: number }>, fills?: Record<string, string>) => {
    const head = [header, "طلبات", "قطع"];
    head.forEach((h, n) => (summary.getCell(top, left + n).value = h));
    styleHeader(summary.getRow(top), left, head.length);
    [...groups.entries()]
      .sort((a, b) => b[1].pieces - a[1].pieces || b[1].orders - a[1].orders)
      .forEach(([label, g], n) => {
        const r = top + 1 + n;
        [label, g.orders, g.pieces].forEach((v, i) => {
          const cell = summary.getCell(r, left + i);
          cell.value = v;
          cell.border = box;
          cell.font = { name: FONT, size: 11, bold: i === 0 && Boolean(fills?.[label]) };
          cell.alignment = { horizontal: i === 0 ? "right" : "center", vertical: "middle", readingOrder: "rtl" };
          const fill = i === 0 ? fills?.[label] : undefined;
          if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
          else if (n % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
        });
        summary.getRow(r).height = 20;
      });
    if (!groups.size) {
      const cell = summary.getCell(top + 1, left);
      cell.value = "—";
      cell.alignment = { horizontal: "center" };
    }
    return top + 2 + Math.max(groups.size, 1);
  };
  const group = (list: Row[], key: (o: Row, i: OrderItem) => string, perItem = true) => {
    const map = new Map<string, { orders: number; pieces: number }>();
    for (const o of list) {
      const items = JSON.parse(o.items) as OrderItem[];
      const seen = new Set<string>();
      for (const i of perItem ? items : items.slice(0, 1)) {
        const k = key(o, i).trim() || "غير محدد";
        const g = map.get(k) ?? { orders: 0, pieces: 0 };
        if (!seen.has(k)) g.orders++;
        seen.add(k);
        g.pieces += perItem ? i.quantity : items.reduce((s, x) => s + x.quantity, 0);
        map.set(k, g);
      }
    }
    return map;
  };

  const byStatus = new Map<string, { orders: number; pieces: number }>();
  for (const s of Object.keys(STATUS) as OrderStatus[]) {
    const list = orders.filter((o) => o.status === s);
    if (list.length) byStatus.set(STATUS[s].label, { orders: list.length, pieces: pieces(list) });
  }
  const statusFills = Object.fromEntries(Object.values(STATUS).map((s) => [s.label, s.fill]));
  const bySource = group(orders, (o) => (o.source === "team" ? "سجّلو الفريق" : "جمعه المساعد"), false);

  let right = table(7, 1, "الحالة", byStatus, statusFills);
  right = table(right, 1, "مين سجّل", bySource);
  table(right, 1, "المقاس", group(live, (_, i) => i.size));
  let left = table(7, 5, "المدينة", group(live, (o) => o.city, false));
  left = table(left, 5, "اللون", group(live, (_, i) => i.color));
  if (live.some((o) => (JSON.parse(o.items) as OrderItem[]).some((i) => i.product))) table(left, 5, "المنتج", group(live, (_, i) => i.product ?? ""));

  return { file: Buffer.from(await wb.xlsx.writeBuffer()), count: orders.length };
}

export const sheetName = (range: SheetRange) =>
  !range.from
    ? `orders-all-${localDay(Date.now())}.xlsx`
    : `orders-${localDay(range.from)}${localDay(range.from) === localDay(range.to - 1) ? "" : `_${localDay(range.to - 1)}`}.xlsx`;

// --- Daily file in the Telegram group -----------------------------------------------------------------

// Sends the last 24 hours' orders (yesterday's daily send until now). Returns how many orders it had.
export async function sendDailySheet(): Promise<number> {
  const to = Date.now();
  const from = to - DAY;
  const range = { from, to };
  const { file, count } = await ordersWorkbook(range, "طلبات آخر 24 ساعة");
  const today = localDay(to);
  if (!count) {
    await notify("sheet", `📊 <b>شيت الطلبات · ${today}</b>\nما في طلبات بآخر 24 ساعة.`);
    return 0;
  }
  const open = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").get() as { n: number }).n;
  await notifyDocument(
    "sheet",
    file,
    `orders-${today}.xlsx`,
    `📊 <b>شيت الطلبات · ${today}</b>\n${count} طلب بآخر 24 ساعة${open ? ` · ${open} لسا بدو تأكيد` : ""}`,
  );
  log("orders", `daily sheet sent (${count} orders)`);
  return count;
}

// Once a day at `hour` (dashboard time), checked by the supervisor's 5-minute tick.
export async function maybeSendDailySheet(hour: number, localHour: number) {
  const today = localDay(Date.now());
  if (localHour !== hour || getSetting("orders_sheet_day") === today) return;
  setSetting("orders_sheet_day", today);
  await sendDailySheet();
}

