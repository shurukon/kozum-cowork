# تقرير التحقق النهائي — Kozum Cowork

## نطاق الإصلاح

تم إصلاح عزل جلسات Cowork وCode على مستوى renderer وZustand وSessionManager. أصبح لكل mode/session identity صريح، وتُرفض الأحداث العالمية التي لا تطابق الجلسة المهروبة، وتُمسح الرسائل والبطاقات والمهام وdedupe IDs عند عبور حد session. كما أصبحت مسارات new/open/branch/edit/archive/delete تحدد الهوية والمرجع المتزامنين قبل hydration. وعند حذف جلسة أثناء تشغيل agent loop، تُرحّل الجلسة قبل abort، وتُمنع late emissions ونتائج الخطأ والكتابات الجانبية، وينتظر teardown sidecar writes قبل حذف المجلد.

في MCP أصبح `Test connection` ينفذ handshake حقيقيًا (`initialize` ثم `tools/list`) ويغلق الاتصال بعد الاختبار، وأصبح `mcp:add` لا يحفظ endpoint غير قابل للاتصال. يدعم localhost فقط عند `allowLocal: true` مع بقاء حماية SSRF للوجهات الخاصة الأخرى. أضيفت persistence إلى `mcp.json`، وتُحفظ tokens في SecretStore تحت namespace `mcp:<serverId>` ولا تُكتب في JSON. كما تم دعم إضافة server مع `enabled=false` بعد handshake دون اتصال فوري.

تم إصلاح endpoint GitHub الافتراضي في تثبيت الإضافات من `refs/heads/HEAD` إلى codeload `/zip/HEAD`. المستودع المخصص المتوافق الذي تم اختباره فعليًا هو [`tsgx1990/openmontage-plugin`](https://github.com/tsgx1990/openmontage-plugin)، وليس [`calesthio/OpenMontage`](https://github.com/calesthio/OpenMontage) الذي لا يحتوي `.claude-plugin/plugin.json`. أضيف اكتشاف بنية Claude الواقعية (`engine/.agents/skills`) وتوسعة `${CLAUDE_PLUGIN_ROOT}` داخل حدود مجلد الإضافة، دون تنفيذ hooks أو ملفات plugin تلقائيًا.

تم إضافة local HTML preview عبر loopback origin عشوائي المسار، مع root canonicalized، منع traversal، MIME types للأصول، وCSP تقيد `connect-src` إلى `none` وتمنع frames/plugins/forms. HTML المحلي يُعرض في iframe sandboxed مع relative CSS/SVG/fonts/media وJavaScript محلي محدود، بينما explicit artifact targets تبقى في ArtifactCanvas المعقم كـfallback آمن. لا يتم استخدام `file://` ولا يتم اختطاف agent browser surface.

## الأدلة الحية

| المجال | الدليل الفعلي |
| --- | --- |
| MCP manager | `artifacts/mcp-local-live.json`: server متصل، أداتان مكتشفتان، `mcp_call` أعاد `42`، وRPC methods هي `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. |
| MCP داخل agent loop | `artifacts/mcp-agent-live.json`: `runAgentLoop` نفذ `tool_start(mcp_call)` ثم `tool_end(ok=true, content=42)`، وأكمل إلى `stopReason=end_turn` خلال دورتين، مع provider turn ثانٍ يحمل `role=tool`. |
| MCP عبر IPC | `mcp-ipc.test.ts`: handshake حقيقي ناجح، dead endpoint مرفوض بلا persistence، وlocalhost مرفوض عندما `allowLocal=false`. |
| OpenMontage | `artifacts/openmontage-plugin-live.json`: تثبيت حي من GitHub codeload وتثبيت ZIP حي نجحا، مع اكتشاف manifest وskills وcommand وMCP contribution وhooks metadata دون تشغيلها. |
| Preview بصري | `artifacts/preview-live-before-click.webp` و`artifacts/preview-live-after-click.webp`: صفحة landing حقيقية تعرض Kozum mark وcompass وspark وlayers وbolt وcheck عبر relative SVG assets. اللقطة الثانية تثبت التفاعل برسالة `Interaction confirmed · local script is running`. |
| Preview security | `tests/integration/preview-server.test.ts`: HTML/CSS/SVG served، CSP موجود، traversal يعيد 403، والهدف غير HTML مرفوض. |
| Delete while running | `tests/integration/session-delete.test.ts`: provider SSE محلي حقيقي، delta يصل، teardown ثم delete، لا أحداث لاحقة، لا مجلد session، وإعادة الإرسال مرفوضة. |

## نتيجة التحقق الآلي

| الأمر | النتيجة |
| --- | --- |
| `npm run typecheck` | ناجح لـ Node وWeb |
| `npm test` | **1165 ناجحة، 0 فشل** |
| `npm run test:component` | **47 ناجحة، 0 فشل، 9 ملفات** |
| `npm run verify` | ناجح؛ capabilities: **0 wrongly blocked من 689** |
| `npm run build` | ناجح؛ main/preload/renderer production bundles بُنيت |
| `git diff --check` | ناجح |
| secret-pattern scan | لا يوجد JWT/API key حقيقي في الملفات الجديدة؛ القيم الموجودة في الاختبارات placeholders فقط |

## ملاحظات أمنية

لم يتم إدخال API key الذي أرسله المستخدم إلى أي ملف أو log أو commit. خادم MCP التجريبي وخادم preview كلاهما loopback مؤقتان، وتم حذف عمليات/ملفات التشغيل المؤقتة بعد التقاط الأدلة. اختبار OpenMontage اقتصر على download/validate/discover؛ لم تُشغّل hooks أو scripts غير موثوقة أثناء التثبيت.
