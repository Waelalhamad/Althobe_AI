// The public privacy policy and data deletion pages the Meta app asks for (served on /privacy and /data-deletion).

const page = (title: string, body: string) => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; line-height: 1.8; max-width: 760px; margin: 0 auto; padding: 32px 16px; color: #1f2933; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
  .en { direction: ltr; text-align: left; border-top: 1px solid #e5e7eb; margin-top: 3rem; padding-top: 1rem; }
  small { color: #6b7280; }
</style>
</head>
<body>
${body}
<p><small>آخر تحديث / Last updated: 2026-10-26</small></p>
</body>
</html>`;

export const PRIVACY_PAGE = page(
  "سياسة الخصوصية - الثوب العربي",
  `<h1>سياسة الخصوصية</h1>
<p>هالصفحة بتشرح شو منعمل بالمعلومات يلي بتبعتلنا ياها لما تراسل «الثوب العربي» على واتساب أو ماسنجر أو إنستغرام.</p>
<h2>شو منحفظ</h2>
<p>الرسائل يلي بتبعتها وردودنا، اسمك بحسابك، والمعلومات يلي بتعطينا ياها لتطلب: الاسم، رقم التلفون، العنوان، والطلب نفسه.</p>
<h2>ليش</h2>
<p>لنرد على أسئلتك، ولنسجّل طلبك ونوصّلو. بعض الردود بيكتبها مساعد ذكي (خدمة OpenAI) من معلومات محلنا، وفريقنا بيشوف المحادثات وبيرد بنفسو وقت يلزم.</p>
<h2>مع مين منشاركها</h2>
<p>مع شركة التوصيل (درب السبيل) بس معلومات التوصيل: الاسم والرقم والعنوان والطلب. ما منبيع معلوماتك ولا منشاركها لأي حدا تاني.</p>
<h2>قديش منحتفظ فيها</h2>
<p>طول ما في حاجة إلها لخدمتك ولسجلات الطلبات، وبتنمسح إذا طلبت.</p>
<h2>مسح معلوماتك</h2>
<p>ابعتلنا رسالة على نفس المحادثة فيها «امسحو معلوماتي»، ومنمسح محادثاتك ومعلوماتك خلال 30 يوم. التفاصيل على <a href="/data-deletion">صفحة مسح المعلومات</a>.</p>
<div class="en">
<h1>Privacy Policy</h1>
<p>This page explains what Al Thobe Alarabi (الثوب العربي) does with the information you send when you message us on WhatsApp, Messenger or Instagram.</p>
<p><b>What we keep:</b> your messages and our replies, your profile name, and the details you give us to order: name, phone number, address and the order.</p>
<p><b>Why:</b> to answer you and to record and deliver your order. Some replies are written by an AI assistant (OpenAI) from our shop's information; our team reads the conversations and answers in person when needed.</p>
<p><b>Sharing:</b> only the delivery details (name, phone, address, order) go to our courier, Darb Assabil. We never sell your information or share it with anyone else.</p>
<p><b>Retention:</b> as long as needed to serve you and keep order records, or until you ask us to delete it.</p>
<p><b>Deletion:</b> send "delete my data" in the same chat and we delete your conversations and information within 30 days. See the <a href="/data-deletion">data deletion page</a>.</p>
</div>`,
);

export const DATA_DELETION_PAGE = page(
  "مسح المعلومات - الثوب العربي",
  `<h1>مسح معلوماتك</h1>
<p>بدك نمسح محادثاتك ومعلوماتك يلي عنا؟</p>
<ol>
<li>ابعتلنا على نفس المحادثة (واتساب أو ماسنجر أو إنستغرام): «امسحو معلوماتي».</li>
<li>فريقنا بيتأكد إنها المحادثة تبعك وبيمسح الرسائل ومعلومات الطلبات المرتبطة فيها خلال 30 يوم.</li>
<li>منبعتلك رسالة لما يخلص المسح.</li>
</ol>
<p>إذا عندك طلب لسا بالطريق، منستنى لحد ما يوصل أو ينلغى قبل ما نمسح معلوماتو.</p>
<div class="en">
<h1>Delete your data</h1>
<ol>
<li>Message us in the same chat (WhatsApp, Messenger or Instagram): "delete my data".</li>
<li>Our team checks the request comes from that chat and deletes the messages and the order details linked to it within 30 days.</li>
<li>We message you when it is done.</li>
</ol>
<p>If an order is still on its way, its details are deleted once it is delivered or cancelled.</p>
</div>`,
);
