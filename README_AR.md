# نظام مستخرج فواتير الغاز - Petrotrade Gas Bill Fetcher

تطبيق متقدم لاستخراج بيانات فواتير الغاز من موقع بيتروتريد (Petrotrade) بشكل آلي، مع قراءة أرقام الحسابات من جداول Google Sheets وإنتاج تقارير PDF شاملة.

## المميزات الرئيسية

- ✅ **قراءة أرقام الحسابات من Google Sheets** - اتصال آمن مع جداول Google
- ✅ **استخراج بيانات الفواتير تلقائياً** - من موقع Petrotrade مباشرة
- ✅ **دعم البروكسي المصري** - استخدام Bright Data proxy للوصول من خارج مصر
- ✅ **توليد تقارير PDF احترافية** - بتصميم عربي حديث
- ✅ **معالجة متعددة الحسابات** - معالجة عشرات الحسابات في عملية واحدة
- ✅ **واجهة مستخدم تفاعلية** - لوحة تحكم React مع Tailwind CSS
- ✅ **نشر سهل على Render** - بدون تعقيدات

## البيانات المستخرجة

يستخرج النظام البيانات التالية لكل حساب:

| البيان | الوصف |
|------|-------|
| رقم الحساب | معرف الحساب الفريد (16 رقم) |
| شهر الإصدار | شهر إصدار الفاتورة |
| الاستهلاك | كمية الغاز المستهلك |
| تسوية مدينة | الرصيد المستحق |
| رصيد دفعات مقدمة | الدفعات المقدمة المتبقية |
| القيمة | إجمالي قيمة الفاتورة |

## المتطلبات

### للتطوير المحلي

- Node.js 22+
- pnpm
- Playwright (يتم تثبيته تلقائياً)

### للنشر على Render

- حساب Render
- بيانات اعتماد Google Sheets (Base64)
- بيانات Bright Data proxy (اختياري)

## الإعدادات المطلوبة

### 1. Google Sheets

قم بإنشاء ورقة عمل Google Sheets بالخطوات التالية:

1. أنشئ ورقة جديدة على Google Sheets
2. أنشئ ورقة عمل باسم `DATA`
3. أضف أرقام الحسابات في العمود B بدءاً من الصف 2
4. احفظ معرف الورقة (الـ ID من الرابط)

### 2. مفتاح Google API

1. انتقل إلى [Google Cloud Console](https://console.cloud.google.com)
2. أنشئ مشروع جديد
3. فعّل Google Sheets API
4. أنشئ حساب خدمة (Service Account)
5. حمّل مفتاح JSON
6. حول المفتاح إلى Base64:

```bash
cat service-account-key.json | base64 -w 0
```

### 3. Bright Data Proxy (اختياري)

إذا كنت خارج مصر، استخدم Bright Data:

1. سجل حساباً على [Bright Data](https://brightdata.com)
2. احصل على بيانات الـ Proxy
3. استخدم البيانات في متغيرات البيئة

## متغيرات البيئة

```env
# Google Sheets
GOOGLE_SHEET_ID=معرف_الورقة_هنا
GOOGLE_CREDENTIALS_BASE64=المفتاح_بصيغة_base64_هنا

# Bright Data Proxy (اختياري)
BRIGHT_DATA_PROXY=brd.superproxy.io:33335
BRIGHT_DATA_USER=اسم_المستخدم_هنا
BRIGHT_DATA_PASS=كلمة_المرور_هنا

# الخادم
PORT=8080
NODE_ENV=production
```

## التثبيت والتشغيل

### التطوير المحلي

```bash
# استنساخ المشروع
git clone https://github.com/melsofany/Gas-Bill-Fetcher.git
cd Gas-Bill-Fetcher

# تثبيت المتطلبات
pnpm install

# إنشاء ملف .env
cp artifacts/api-server/.env.example artifacts/api-server/.env

# ملء متغيرات البيئة في .env

# تشغيل الخادم
pnpm run dev
```

### النشر على Render

#### الطريقة 1: من خلال واجهة Render

1. انتقل إلى [Render Dashboard](https://dashboard.render.com)
2. اختر "New +" ثم "Web Service"
3. اختر "Deploy from a Git repository"
4. اربط مستودع GitHub الخاص بك
5. اختر الفرع الرئيسي
6. ملء البيانات:
   - **Name**: gas-bill-fetcher
   - **Runtime**: Node
   - **Build Command**: `pnpm install && pnpm run build`
   - **Start Command**: `cd artifacts/api-server && node --enable-source-maps ./dist/index.mjs`
7. أضف متغيرات البيئة:
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_CREDENTIALS_BASE64`
   - `BRIGHT_DATA_PROXY`
   - `BRIGHT_DATA_USER`
   - `BRIGHT_DATA_PASS`
8. اضغط "Create Web Service"

#### الطريقة 2: باستخدام Render CLI

```bash
# تثبيت Render CLI
npm install -g @render-com/cli

# تسجيل الدخول
render login

# نشر المشروع
render deploy
```

## استخدام API

### الحصول على أرقام الحسابات

```bash
GET /api/scraper/accounts
```

**الرد:**
```json
{
  "accounts": ["1234567890123456", "9876543210987654"],
  "count": 2
}
```

### بدء عملية الاستخراج

```bash
POST /api/scraper/run
Content-Type: application/json

{
  "accounts": ["1234567890123456"],
  "proxyUrl": "http://user:pass@proxy:port" // اختياري
}
```

**الرد:**
```json
{
  "jobId": "uuid-here",
  "status": "running",
  "totalAccounts": 1,
  "processedAccounts": 0,
  "results": [],
  "startedAt": "2024-01-01T12:00:00Z",
  "completedAt": null,
  "pdfReady": false
}
```

### التحقق من حالة العملية

```bash
GET /api/scraper/status/:jobId
```

### تحميل ملف PDF

```bash
GET /api/scraper/pdf/:jobId
```

### البحث عن بروكسي متاح

```bash
POST /api/scraper/find-proxy
```

## هيكل المشروع

```
Gas-Bill-Fetcher/
├── artifacts/
│   ├── api-server/          # خادم Express الرئيسي
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   └── scraper.ts    # منطق السكرابر الرئيسي
│   │   │   └── lib/
│   │   │       └── agent-relay.ts # نظام الوكيل المحلي
│   │   └── package.json
│   ├── petrotrade-scraper/  # واجهة المستخدم React
│   │   └── src/
│   │       └── pages/
│   │           └── dashboard.tsx
│   └── mockup-sandbox/      # بيئة الاختبار
├── lib/                     # مكتبات مشتركة
│   ├── api-client-react/    # عميل API React
│   ├── api-spec/            # مواصفات OpenAPI
│   └── db/                  # قاعدة البيانات
├── scripts/
│   └── local-agent/         # وكيل محلي للتشغيل من مصر
├── Dockerfile               # صورة Docker
├── render.yaml              # تكوين Render
└── package.json
```

## استكشاف الأخطاء

### خطأ: "لم يتم العثور على أرقام حسابات"

- تحقق من معرف ورقة Google Sheets
- تأكد من وجود البيانات في العمود B من الصف 2
- تحقق من صحة بيانات اعتماد Google API

### خطأ: "فشل الاتصال بموقع Petrotrade"

- تحقق من الاتصال بالإنترنت
- استخدم بروكسي مصري إذا كنت خارج مصر
- تأكد من أن موقع Petrotrade يعمل

### خطأ: "فشل توليد PDF"

- تحقق من توفر ذاكرة كافية
- تأكد من تثبيت Playwright بشكل صحيح
- جرب إعادة تشغيل الخادم

## الأداء والحدود

- **الحد الأقصى للحسابات في عملية واحدة**: 100 حساب
- **المهلة الزمنية لكل حساب**: 120 ثانية
- **حجم ملف PDF**: عادة 100-500 KB

## الأمان

- ✅ بيانات اعتماد Google محمية بـ Base64
- ✅ لا تُخزن كلمات المرور في الكود
- ✅ اتصالات HTTPS آمنة
- ✅ معالجة آمنة للأخطاء

## المساهمة

نرحب بالمساهمات! يرجى:

1. Fork المشروع
2. إنشاء فرع للميزة الجديدة
3. Commit التغييرات
4. Push إلى الفرع
5. فتح Pull Request

## الترخيص

MIT License - انظر ملف LICENSE

## الدعم

للمساعدة والدعم:

- 📧 البريد الإلكتروني: support@example.com
- 🐛 الإبلاغ عن الأخطاء: [GitHub Issues](https://github.com/melsofany/Gas-Bill-Fetcher/issues)
- 💬 النقاش: [GitHub Discussions](https://github.com/melsofany/Gas-Bill-Fetcher/discussions)

---

**ملاحظة**: هذا المشروع مخصص للاستخدام الشخصي والتعليمي. تأكد من الامتثال لشروط خدمة موقع Petrotrade.
