import { useState } from "react";
import {
  useGetAccounts,
  useRunScraper,
  useGetJobStatus,
  getGetJobStatusQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Building2, Download, Play, AlertCircle, CheckCircle2, Clock, ChevronDown, ChevronUp, Wifi } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function Dashboard() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [proxyUrl, setProxyUrl] = useState<string>("");
  const [showProxySection, setShowProxySection] = useState(true);

  const { data: accountsData, isLoading: isLoadingAccounts, error: accountsError } = useGetAccounts();
  const runScraperMutation = useRunScraper();

  const { data: jobData, error: jobError } = useGetJobStatus(activeJobId || "", {
    query: {
      enabled: !!activeJobId,
      refetchInterval: (query) => {
        return query.state.data?.status === "running" ? 3000 : false;
      },
      queryKey: activeJobId ? getGetJobStatusQueryKey(activeJobId) : ["scraperJob", "empty"],
    }
  });

  const handleStartExtraction = () => {
    runScraperMutation.mutate(
      { data: { proxyUrl: proxyUrl.trim() || undefined } },
      {
        onSuccess: (data) => {
          setActiveJobId(data.jobId);
        }
      }
    );
  };

  const isRunning = jobData?.status === "running";
  const isCompleted = jobData?.status === "completed";
  const isFailed = jobData?.status === "failed";

  const progressPercent = jobData?.totalAccounts
    ? (jobData.processedAccounts / jobData.totalAccounts) * 100
    : 0;

  const errorSample = jobData?.results?.find(r => r.status === "error")?.error || "";
  const isNetworkError = errorSample.toLowerCase().includes("timeout") ||
    errorSample.includes("net::ERR") ||
    errorSample.includes("ERR_CONNECTION");

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-5xl space-y-5">

        {/* Header */}
        <div className="flex items-center gap-4 border-b border-slate-200 pb-5">
          <div className="h-12 w-12 bg-primary rounded-xl flex items-center justify-center shadow-md shadow-primary/20 shrink-0">
            <Building2 className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">مستخرج فواتير بيتروتريد</h1>
            <p className="text-slate-500 text-sm">نظام استخراج آلي لبيانات الاستهلاك والمطالبات</p>
          </div>
        </div>

        {/* Proxy Configuration Card */}
        <Card className="border-amber-300 bg-amber-50">
          <button
            className="w-full flex items-center gap-3 px-5 py-3.5 text-right"
            onClick={() => setShowProxySection(!showProxySection)}
            data-testid="button-toggle-proxy"
          >
            <Wifi className="h-4 w-4 text-amber-600 shrink-0" />
            <span className="text-sm font-semibold text-amber-900 flex-1 text-right">
              إعداد البروكسي المصري
            </span>
            <span className="text-xs text-amber-700 font-normal ml-2">
              {proxyUrl ? "تم الإعداد" : "غير محدد"}
            </span>
            {showProxySection
              ? <ChevronUp className="h-4 w-4 text-amber-600 shrink-0" />
              : <ChevronDown className="h-4 w-4 text-amber-600 shrink-0" />
            }
          </button>

          {showProxySection && (
            <CardContent className="px-5 pb-4 pt-0 space-y-3">
              <p className="text-sm text-amber-800">
                موقع بيتروتريد لا يعمل إلا من داخل مصر. أدخل رابط بروكسي مصري لتمرير الطلبات عبره.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-amber-900">رابط البروكسي</label>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://username:password@proxy.example.com:8080"
                  className="w-full border border-amber-300 rounded-lg px-3 py-2 text-sm font-mono bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400 text-left"
                  dir="ltr"
                  data-testid="input-proxy-url"
                />
              </div>
              <div className="bg-white/70 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
                <p className="font-semibold">مثال:</p>
                <code className="block font-mono text-slate-700">http://user:pass@proxy-eg.example.com:8080</code>
                <p className="mt-2 text-amber-700">بديل: انشر التطبيق على سيرفر داخل مصر حيث لا تحتاج بروكسي.</p>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Geo-block warning */}
        {(isFailed || isNetworkError) && activeJobId && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>فشل الاتصال بموقع بيتروتريد</AlertTitle>
            <AlertDescription>
              الموقع محجوب من خارج مصر. أدخل رابط بروكسي مصري في الإعدادات أعلاه ثم أعد المحاولة.
            </AlertDescription>
          </Alert>
        )}

        {/* Action Bar */}
        <Card className="shadow-sm border-slate-200">
          <CardContent className="p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex-1 text-right">
              <h2 className="text-base font-semibold text-slate-900">التحكم بالعمليات</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {isLoadingAccounts ? (
                  "جاري تحميل الحسابات..."
                ) : accountsData ? (
                  `${accountsData.count} حساب جاهز للاستخراج`
                ) : (
                  "لا توجد بيانات حسابات"
                )}
              </p>
            </div>

            <Button
              onClick={handleStartExtraction}
              disabled={isLoadingAccounts || isRunning || runScraperMutation.isPending || !accountsData?.count}
              className="w-full sm:w-auto bg-amber-500 hover:bg-amber-600 text-white font-bold h-11 px-8 shadow"
              data-testid="button-start-extraction"
            >
              {runScraperMutation.isPending ? (
                "جاري الإطلاق..."
              ) : isRunning ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  قيد الاستخراج
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Play className="h-4 w-4" />
                  بدء الاستخراج
                </span>
              )}
            </Button>
          </CardContent>
        </Card>

        {accountsError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>خطأ في جلب الحسابات</AlertTitle>
            <AlertDescription>يرجى التأكد من إعدادات Google Sheet والاتصال بالخادم.</AlertDescription>
          </Alert>
        )}
        {jobError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>خطأ في متابعة العملية</AlertTitle>
            <AlertDescription>فشل في الاتصال بالخادم لجلب حالة الاستخراج.</AlertDescription>
          </Alert>
        )}

        {/* Progress */}
        {activeJobId && jobData && (
          <Card className="shadow-sm border-slate-200">
            <CardHeader className="py-3 px-5 border-b border-slate-100">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base">حالة العملية</CardTitle>
                <Badge
                  className={`px-3 py-1 text-sm font-medium ${
                    isRunning ? "bg-blue-100 text-blue-800 hover:bg-blue-100" :
                    isCompleted ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" :
                    "bg-red-100 text-red-800 hover:bg-red-100"
                  }`}
                >
                  {isRunning && <Clock className="w-3.5 h-3.5 ml-1 inline-block animate-pulse" />}
                  {isCompleted && <CheckCircle2 className="w-3.5 h-3.5 ml-1 inline-block" />}
                  {isFailed && <AlertCircle className="w-3.5 h-3.5 ml-1 inline-block" />}
                  {isRunning ? "قيد التشغيل" : isCompleted ? "مكتمل" : "فشل"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-5 space-y-4">
              <div className="flex justify-between items-center text-sm">
                <span className="font-medium text-slate-700">تقدم الاستخراج</span>
                <span className="text-slate-500 font-mono bg-slate-100 px-2.5 py-1 rounded text-xs">
                  {jobData.processedAccounts} / {jobData.totalAccounts}
                </span>
              </div>
              <Progress value={progressPercent} className="h-2.5" />

              {isCompleted && jobData.pdfReady && (
                <div className="pt-1 flex justify-start">
                  <a
                    href={`/api/scraper/pdf/${jobData.jobId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-bold h-10 px-6 transition-colors shadow"
                    data-testid="link-download-pdf"
                  >
                    <Download className="h-4 w-4" />
                    تحميل تقرير PDF
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Results Table */}
        {activeJobId && jobData?.results && jobData.results.length > 0 && (
          <Card className="shadow-sm border-slate-200">
            <CardHeader className="py-3 px-5 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">النتائج المستخرجة</CardTitle>
                {jobData.results.some(r => r.status === "error") && (
                  <span className="text-xs text-red-600 font-medium">
                    {jobData.results.filter(r => r.status === "error").length} حساب به خطأ
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-50">
                    <TableRow className="hover:bg-transparent border-b border-slate-200">
                      <TableHead className="text-right font-bold text-slate-700 py-3">رقم الحساب</TableHead>
                      <TableHead className="text-right font-bold text-slate-700">شهر الإصدار</TableHead>
                      <TableHead className="text-right font-bold text-slate-700">الاستهلاك</TableHead>
                      <TableHead className="text-right font-bold text-slate-700">تسوية مدينة</TableHead>
                      <TableHead className="text-right font-bold text-slate-700">رصيد دفعات مقدمة</TableHead>
                      <TableHead className="text-right font-bold text-slate-700">القيمة</TableHead>
                      <TableHead className="text-right font-bold text-slate-700">الحالة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobData.results.map((result, idx) => (
                      <TableRow
                        key={`${result.accountNumber}-${idx}`}
                        data-testid={`row-result-${idx}`}
                        className={
                          result.status === "error" ? "bg-red-50/60" :
                          result.status === "pending" ? "opacity-60" : ""
                        }
                      >
                        <TableCell className="font-mono text-sm font-medium">{result.accountNumber}</TableCell>
                        <TableCell className="text-slate-600">{result.issueMonth || "—"}</TableCell>
                        <TableCell>{result.consumption || "—"}</TableCell>
                        <TableCell>{result.creditAdjustment || "—"}</TableCell>
                        <TableCell>{result.advanceBalance || "—"}</TableCell>
                        <TableCell className="font-semibold">{result.amount || "—"}</TableCell>
                        <TableCell>
                          {result.status === "success" && (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-xs">ناجح</Badge>
                          )}
                          {result.status === "error" && (
                            <div className="flex flex-col gap-1 max-w-xs">
                              <Badge variant="destructive" className="w-fit text-xs">خطأ</Badge>
                              <span className="text-xs text-red-600 truncate" title={result.error || ""}>
                                {isNetworkError
                                  ? "تعذر الوصول للموقع — مطلوب بروكسي مصري"
                                  : (result.error || "").substring(0, 70)}
                              </span>
                            </div>
                          )}
                          {result.status === "pending" && (
                            <Badge variant="outline" className="text-slate-400 text-xs">قيد الانتظار</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
