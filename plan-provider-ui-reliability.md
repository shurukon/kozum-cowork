# خطة إصلاح Providers وAgent Router واستقرار واجهة Kozum

## الهدف

إصلاح النسخة الحالية من Kozum Cowork على فرع `main` بحيث يعمل Agent Router وفق نمط wire/model configuration المطلوب بدل تجاهل إعداداته، وإعادة بناء مفهوم Custom Provider من مجرد API key إلى provider كامل قابل للإدارة، مع إصلاح استقرار الأخطاء والمعاينة، وتحسين موثوقية الطلبات عند ضعف الشبكة، وتصحيح retry/edit في Cowork وCode. بعد تنفيذ الإصلاحات والتحقق البصري والاختبارات، تُرفع التغييرات إلى GitHub فقط؛ **لن يتم بناء أو رفع ملف EXE في هذه الدورة**.

## المرحلة الأولى: تثبيت baseline وفهم العقود الحالية

سيتم جلب آخر `origin/main` وفحص حالة المستودع ونسخة التطبيق الحالية. ستُراجع عقود `ProviderPreset`, `ApiKeyEntry`, `AppSettings`, وIPC/preload/renderer bridge، مع الحفاظ على توافق البيانات القديمة. ستُراجع أيضًا جميع مواضع اختيار provider/model في Cowork وCode، لأن إصلاح provider لا يجوز أن يغير session أو mode state الخاص بأي منهما.

سيُحدد عقد Agent Router الفعلي من الكود الحالي ووثائق/سلوك endpoint المتاح بدل افتراض أن كل gateway يتصرف مثل OpenAI Chat. سيشمل ذلك تحديد طريقة اختيار النمط المطلوب (مثل نمط Kilo Code أو Claude Code أو النموذج/المسار الذي يفرضه Agent Router)، وما إذا كان الاختلاف في model id أو protocol أو headers أو request body. لن يُضاف fallback صامت إلى OpenAI Chat عند عدم تطابق النمط؛ سيظهر خطأ تشخيصي واضح ويُختبر كل route بصورة مستقلة.

## المرحلة الثانية: إصلاح Agent Router والـprovider routing

سيُضاف تمثيل صريح لنمط Agent Router داخل provider configuration أو model routing، مع validation تمنع حفظ configuration ناقصة أو غير مدعومة. سيُفصل اختيار adapter عن اختيار gateway mode، وتُمرر الحقول المطلوبة إلى request adapter دون المساس بموفري Kilo Gateway وNVIDIA NIM وOpenRouter وOpenCode الذين يعملون حاليًا.

ستُضاف اختبارات adapter/registry تغطي: اختيار النمط الصحيح لكل model أو mode، عدم إرسال route غير مناسب، الحفاظ على headers/base URL، رسائل الخطأ عند mode غير معروف، وعدم وجود regression في البروتوكولات OpenAI Chat وResponses وAnthropic. ستستخدم اختبارات HTTP المحلية خادمًا فعليًا يلتقط requests ويعيد wire responses حقيقية؛ لن تُختصر الاختبارات باستدعاء دالة mock تتجاوز طبقة الشبكة أو adapter.

## المرحلة الثالثة: إعادة بناء Custom Providers

سيصبح `Add key` في قسم provider هو `Add provider` عند إنشاء provider جديد. نموذج الإضافة سيطلب الحقول الأربعة المطلوبة: **الاسم، Base URL، API key، Model ID**. الاسم وBase URL يصبحان خصائص ثابتة للprovider بعد الإنشاء، بينما تُدار المفاتيح والنماذج كقوائم مستقلة قابلة للإضافة لاحقًا.

سيُحافظ التخزين على المفاتيح داخل `SecretStore` المشفر، مع provider ID ثابت لكل custom provider. ستُخزن model IDs في provider definition/settings مع migration آمن للنسخة الحالية التي تستخدم `modelIds` و`apiKey`. سيُسمح بعد الإنشاء بإضافة key آخر أو model ID آخر، مع إزالة التكرار والتحقق من القيم، واختيار key/model فعّالين لكل mode. سيُسمح بعدد غير محدود من custom providers.

سيُطبق حذف custom provider بصورة كاملة: إزالة تعريفه من settings، حذف جميع secrets التابعة له من SecretStore، وتنظيف أي selections تشير إلى provider المحذوف مع fallback آمن إلى اختيار فارغ. سيُمنع حذف built-in providers، وسيظهر تأكيد داخل الواجهة قبل حذف custom provider. ستُضاف IPC methods typed مثل create/update/remove provider، add/remove provider key، add/remove model، مع عدم إعادة raw API keys إلى renderer.

سيُعاد تصميم `SettingsPage` و`CustomProviderDialog`/النموذج الفعلي بحيث يعرضان provider cards مستقرة، ويدعمان تعديل القوائم دون إعادة فتح wizard الإنشاء. ستُحدّث `providers:presets`, `providers:listKeys`, `providers:addCustom`, `providers:updateCustom`, `providers:removeCustom`, وbridge/preload contracts، مع إبقاء built-in provider behavior كما هو.

## المرحلة الرابعة: الشبكات الضعيفة وموثوقية agent requests

ستُراجع `fetchWithRetry` وقراءة SSE حتى لا يتوقف الطلب بصمت بعد بدء stream. سيُضاف bounded retry/backoff مع timeout واضح وterminal error inline، مع التمييز بين فشل الاتصال قبل أول response، وانقطاع stream بعد ظهور محتوى، وفشل provider النهائي. لن يُعاد تنفيذ tool call تلقائيًا بعد أن بدأ أو اكتمل، لتجنب تكرار side effects؛ وإذا تعذر الاستئناف، ستظهر الرسالة والحالة داخل chat مع إمكانية retry آمن من المستخدم.

سيُحافظ كل send على `clientTurnId` ثابت لمنع duplicate submission عند إعادة المحاولة، وستُمنع إعادة استخدام in-flight request بعد timeout أو disconnect. سيبقى زر الإيقاف صالحًا حتى أثناء انتظار الشبكة أو قراءة stream. ستُضاف اختبارات HTTP حقيقية لخادم محلي يتأخر أو يقطع SSE أو يعيد 429/5xx، مع assertions على backoff، عدم duplicate tool execution، terminal state، وإمكانية الإرسال اللاحق.

## المرحلة الخامسة: إصلاح retry وedit في Cowork وCode

سيُفصل retry/edit عن `handleSubmit(text)` العام. عند retry ستُزال الرسالة المستهدفة ونتائجها من transcript المرئي والمنطقي ثم يُعاد إرسال نفس user turn كأنه الطلب الحالي، دون ظهور نسخة ثانية من الرسالة القديمة. عند edit سيُنشأ prefix/branch صحيح قبل الرسالة المعدلة، وتُحدّث session identity وZustand state وactive ref ذريًا قبل الإرسال، بحيث تختفي الرسالة القديمة ولا تبقى في chat.

سيُراجع backend/session store لتحديد نقطة القطع بدقة، وحفظ history متسق، ومنع late response من الجلسة القديمة من الظهور في الجلسة الجديدة. سيُطبق السلوك نفسه في Cowork وCode مع احترام mode isolation، وستُضاف اختبارات renderer/store وIPC/session integration لمسارات retry، edit، retry أثناء request، والتبديل السريع بين الجلسات.

## المرحلة السادسة: استقرار errors وpreview والـresponsive layout

ستُمنع رسائل الخطأ من التمدد فوق التطبيق عبر تحويلها إلى inline regions ذات `min-width: 0`, `max-width: 100%`, `overflow-wrap:anywhere`, وارتفاع/تمرير محدود عند الحاجة، مع إزالة أي overlay أو fixed positioning غير ضروري. سيُراجع App banner وChatView وPreviewPanel وflex/grid constraints، خصوصًا اجتماع chat مع preview على الشاشات الضيقة.

سيُثبت preview داخل rail مرن لا يتجاوز حدود viewport، مع drag/resize limits، وfallback واضح عند فشل live preview، وعدم السماح لخطأ أو محتوى HTML طويل بتوسيع shell أو تغطية chat. ستُختبر أنواع HTML والصور والفيديو والملفات النصية، مع بقاء sandbox/CSP ومسار preview الآمن.

ستُستبدل درجة الأزرق الساطع في user messages بلون muted متناسق مع dark theme، مع contrast قابل للقراءة في hover/focus/error. سيُحدد نظام typography واضح؛ سيُستخدم خط واجهة احترافي موجود في المشروع، ويُطبق الميلان بصورة مقصودة على نص رسالة المستخدم/النص المطلوب دون جعل أزرار الواجهة أو رسائل الخطأ مائلة بصورة مربكة. ستُراجع Cowork وCode بصريًا لضمان اتساقهما مع اختلاف ألوان mode.

## المرحلة السابعة: الاختبارات والتحقق البصري

سيُشغل typecheck Node/Web، اختبارات Node integration/unit، component tests، capabilities tests، وbuild verification المناسب دون إنشاء EXE. ستُضاف/تُحدّث اختبارات للـprovider schema، custom provider CRUD، سرية المفاتيح، Agent Router routes، weak-network streaming، retry/edit، error bounds، وpreview bounds.

سيتم تشغيل التطبيق فعليًا في Electron/Chromium باستخدام profile اختبار لا يحتوي أسرارًا مكشوفة، ثم التقاط لقطات لكل من Cowork وCode تشمل provider picker، custom provider creation وإضافة key/model، Agent Router mode، error داخل chat، retry/edit، وpreview مع resize. ستُراجع اللقطات للتأكد من عدم وجود overlay أو قص أو overflow، ومن أن الرسالة المعدلة/المعادة لا تظهر مرتين. لن تُعتبر الاختبارات البصرية ناجحة بمجرد render snapshot إذا كان السلوك يعتمد على IPC أو layout حقيقي.

## المرحلة الثامنة: التسليم والرفع

قبل الرفع سيُجرى `git diff --check` ومسح secrets، ومراجعة `git status` وdiff summary. لن تُطبع أو تُحفظ أي API keys حقيقية. بعد نجاح جميع الاختبارات، سيُنشأ commit وصفي ويُدفع إلى `origin/main`. سيُرفق تقرير عربي موجز يحتوي commit، الاختبارات، الأدلة البصرية، وأي limitation متبقية. **لا يُنفذ `build:win` ولا تُرفع artifacts EXE في هذه الدورة**.

## معايير القبول

| المجال | معيار القبول |
|---|---|
| Agent Router | route/mode المطلوب يعمل عبر adapter الفعلي، والخطأ عند mode غير مدعوم واضح، ولا regression في Kilo/NVIDIA/OpenRouter/OpenCode |
| Custom Provider | إنشاء provider بالاسم وBase URL وAPI key وModel ID، ثم إضافة keys/models بلا حد عملي، وحذف provider ينظف تعريفه ومفاتيحه |
| الأمن | لا raw API key في renderer أو JSON أو logs أو tests الجديدة، وbuilt-ins غير قابلة للحذف |
| الشبكة | retries محدودة ومرئية، لا duplicate tool execution، وsend/cancel يعملان بعد disconnect أو timeout |
| retry/edit | لا duplicate user message، والرسالة المعدلة/المعادة تحل محل القديمة في Cowork وCode |
| UI | errors وpreview داخل حدود layout، دون تغطية shell، مع ألوان وخطوط متناسقة وقابلة للاستخدام |
| التحقق | typecheck وNode tests وcomponent tests وverify تمر بلا failures، مع أدلة Electron/Chromium بصرية |
| التسليم | commit مرفوع إلى GitHub، دون بناء EXE في هذه الدورة |

## افتراضات ومخاطر

يفترض التنفيذ أن آخر نسخة على `origin/main` هي مصدر الحقيقة وأن بيانات custom providers القديمة يجب migration لا حذفها. إذا لم توفر وثائق Agent Router نمطًا قابلًا للتحقق أو احتاجت route إلى credentials غير موجودة في profile، سيُفصل ذلك بوضوح في التقرير ويُختبر wire contract بخادم محلي حقيقي دون الادعاء بنجاح vendor live. كذلك فإن ضعف الشبكة قد يمنع استئناف stream بعد ظهور partial output؛ في هذه الحالة الأولوية لمنع التكرار وإظهار حالة قابلة لإعادة المحاولة بدل تنفيذ request أو tool مرتين.
