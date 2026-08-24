# تقرير تحقق دورة إصلاح Providers وموثوقية الواجهة

التاريخ: 24 أغسطس 2026

## النتيجة

اكتملت دورة الإصلاح على فرع `main` فوق baseline `53e4bbb`. شملت الدورة AgentRouter، Custom Providers، تحمل الشبكات الضعيفة، retry/edit في Cowork وCode، bounded errors/preview، وتحسين مظهر رسائل المستخدم. لا يحتوي هذا التقرير أو المستودع على API key حقيقي.

## AgentRouter

تمت مطابقة التوجيه مع [الدليل الرسمي لـ AgentRouter](https://co.agentrouter.org/portal/guide): نماذج Claude تستخدم بروتوكول Anthropic ومسار `/messages` على base URL بدون `/v1`، بينما نماذج OpenAI والعائلات الأخرى تستخدم OpenAI Chat على `https://co.agentrouter.org/v1`. أصبح اختيار البروتوكول model-aware، مع دعم IDs ذات namespace وحالة matching غير حساسة لحالة الأحرف.

اختبار wire حقيقي شغّل خادم `node:http` محليًا، ثم مرّر adapters الفعلية عبر HTTP. أثبت الاختبار أن Claude وصل إلى `/messages` مع `x-api-key`، وأن GPT وصل إلى `/v1/chat/completions` مع `Authorization: Bearer`. النتيجة: 13/13 في `providers-custom.test.ts`.

## Custom Providers

أصبح إنشاء المزود يتطلب الاسم وBase URL وAPI key وModel ID في عملية واحدة، مع تخزين المفتاح عبر SecretStore. بعد الإنشاء يمكن إضافة مفاتيح ونماذج متعددة، ولا يمكن تغيير الاسم أو Base URL، ويمكن حذف المزود بالكامل مع تنظيف المفاتيح والاختيارات المرتبطة به. اختبار IPC الحقيقي استخدم SettingsStore وSecretStore وIPC fake مطابقًا للعقد، والنتيجة مضمّنة ضمن suite الكامل دون failures.

## الشبكة وAgent loop

أضيف idle timeout افتراضي لبث SSE، مع إلغاء reader عند التعليق. retry يظل قبل بدء output فقط؛ لا تتم إعادة POST بعد ظهور text أو tool call، لتجنب تكرار side effects. أضيف اختبار SessionManager حقيقي عبر خادم HTTP: أرسل stream جزءًا ثم قطع الاتصال، فظهر `error` و`session_status:error`، لم يتكرر POST، ثم قبلت الجلسة إرسالًا صريحًا لاحقًا وعادت إلى `idle`. كما يُستعاد نص الرسالة في composer عند رفض send الفوري بسبب فشل مؤقت في الشبكة.

## Retry وEdit

أصبح retry/edit يعتمدان على `messageId` الدقيق. يتم عمل branch قبل الرسالة، إزالة tail القديم، تحديث session identity، ثم retry كدور جديد بلا user/assistant/tool tail مكرر. أما edit فيزيل الدور القديم ويضع النص في composer. يوجد regression component للتحقق من تمرير `messageId` و`text`، واختبار App لاستعادة draft عند فشل الإرسال.

## الواجهة وPreview

أصبح user bubble بلون dark muted مع نص italic مقروء، وتبقى أزرار copy/edit/retry منفصلة في الجهة اليمنى. صارت inline errors وglobal banners وErrorBoundary وPreview محكومة بأبعاد وoverflow آمنة. أُصلحت CSP للسماح بإطارات loopback preview فقط (`127.0.0.1` و`localhost` مع wildcard port)، مع الحفاظ على default-src وباقي القيود.

تشغيل Electron/Playwright الحقيقي في Cowork وCode نفّذ مهمة طويلة باستخدام provider HTTP حي، وكتب ملف HTML، وأنشأ progress/tool events، وفتح rendered design وLive browser preview. ظهرت progress داخل chat، وبقي زر الإيقاف الأحمر متاحًا أثناء التشغيل، ونجح native browser screenshot. لم تسجل المحاولات النهائية أخطاء renderer أو `ERR_BLOCKED_BY_CSP`. أضيفت أيضًا لقطة narrow بعد تصغير النافذة إلى 900×700، وبقي preview rail محدودًا مع بقاء chat وcomposer ظاهرين.

الأدلة البصرية:

- `artifacts/chat-ui/cowork/chat-live-long-running.png`
- `artifacts/chat-ui/cowork/chat-live-preview.png`
- `artifacts/chat-ui/cowork/chat-live-narrow-preview.png`
- `artifacts/chat-ui/code/chat-live-long-running.png`
- `artifacts/chat-ui/code/chat-live-preview.png`
- `artifacts/chat-ui/cowork/chat-live-browser-native.jpg`
- `artifacts/chat-ui/cowork/visual-review.md`

## مصفوفة التحقق النهائية

| الفحص | النتيجة |
|---|---:|
| `npm run typecheck` | ناجح |
| `npm test` | 1222/1222 ناجحة، 347 suite، 0 failures |
| `npm run test:component` | 57/57 ناجحة، 11 ملفًا، 0 failures |
| `npm run test:capabilities` | 0 wrongly hard-blocked من 689 |
| `npm run build` | ناجح، main/preload/renderer bundled |
| Electron E2E | 7/7 ناجحة |
| live Cowork/Code visual harness | completed + preview/browser/native captures |
| EXE build | لم يُنفّذ حسب الطلب |

تم تنفيذ `git diff --check` دون مخرجات، كما أن scan الأسرار لم يجد مفاتيح حقيقية؛ القيم الظاهرة في اختبارات SecretStore اصطناعية ومخصصة للاختبار فقط.
