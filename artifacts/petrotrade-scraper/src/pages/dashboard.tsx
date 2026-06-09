import { useState, useEffect, useRef } from "react";
import {
  useGetAccounts,
  useRunScraper,
  useGetJobStatus,
  useFindProxy,
  useGetProxySearchStatus,
  useGetAgentStatus,
  getGetJobStatusQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Building2, Download, Play, AlertCircle, CheckCircle2, Clock, ChevronDown, ChevronUp, Wifi, Search, X, Terminal, Zap } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const SERVER_WS_URL = (() => {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  // hostname بدون port — الـ API server دايماً على port 80/443
  return `${proto}://${window.location.hostname}`;
})();

export default function Dashboard() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [proxyUrl, setProxyUrl] = useState<string>("");
  const [showProxySection, setShowProxySection] = useState(false);
  const [proxySearchId, setProxySearchId] = useState<string | null>(null);
  const [proxySearchDone, setProxySearchDone] = useState(false);
  const [showAgentInstructions, setShowAgentInstructions] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: agentStatusData, refetch: refetchAgentStatus } = useGetAgentStatus({
    query: { refetchInterval: 5000 }
  });

  const agentConnected = agentStatusData?.connected === true;

  const { data: accountsData, isLoading: isLoadingAccounts, error: accountsError } = useGetAccounts();
  const runScraperMutation = useRunScraper();
  const findProxyMutation = useFindProxy();

  const { data: jobData, error: jobError } = useGetJobStatus(activeJobId || "", {
    query: {
      enabled: !!activeJobId,
      refetchInterval: (query) => query.state.data?.status === "running" ? 3000 : false,
      queryKey: activeJobId ? getGetJobStatusQueryKey(activeJobId) : ["scraperJob", "empty"],
    }
  });

  const { data: proxySearchData, refetch: refetchProxySearch } = useGetProxySearchStatus(
    proxySearchId || "",
    { query: { enabled: false, queryKey: ["proxySearch", proxySearchId] } }
  );

  useEffect(() => {
    if (!proxySearchId || proxySearchDone) return;
    pollIntervalRef.current = setInterval(async () => {
      const result = await refetchProxySearch();
      const data = result.data;
      if (data && (data.status === "found" || data.status === "not_found")) {
        setProxySearchDone(true);
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        if (data.status === "found" && data.proxyUrl) setProxyUrl(data.proxyUrl);
      }
    }, 2000);
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, [proxySearchId, proxySearchDone, refetchProxySearch]);

  const handleStartExtraction = () => {
    runScraperMutation.mutate(
      { data: { proxyUrl: proxyUrl.trim() || undefined } },
      { onSuccess: (data) => setActiveJobId(data.jobId) }
    );
  };

  const handleFindProxy = () => {
    setProxySearchDone(false);
    setProxySearchId(null);
    findProxyMutation.mutate(undefined, {
      onSuccess: (data) => setProxySearchId(data.searchId)
    });
  };

  const handleCancelSearch = () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    setProxySearchDone(true);
    setProxySearchId(null);
  };

  const isSearching = !!proxySearchId && !proxySearchDone;
  const searchStatus = proxySearchData?.status;
  const searchTested = proxySearchData?.tested ?? 0;
  const searchTotal = proxySearchData?.total ?? 0;
  const searchMessage = proxySearchData?.message ?? "";
  const searchProgress = searchTotal > 0 ? Math.round((searchTested / searchTotal) * 100) : 0;

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

  const agentInstallCmd = `cd petrotrade-local-agent && npm install && node index.mjs --server ${SERVER_WS_URL}`;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-5xl space-y-5">

        {/* Header */}
        <div className="flex items-center gap-4 border-b border-slate-200 pb-5">
          <div className="h-12 w-12 bg-primary rounded-xl flex items-center justify-center shadow-md shadow-primary/20 shrink-0">
            <Building2 className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">مستخرج فواتير بيتروتريد</h1>
            <p className="text-slate-500 text-sm">نظام استخراج آلي لبيانات الاستهلاك والمطالبات</p>
          </div>
        </div>

        {/* Agent Status Card */}
        <Card className={agentConnected ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}>
          <button
            className="w-full flex items-center gap-3 px-5 py-3.5 text-right"
            onClick={() => setShowAgentInstructions(!showAgentInstructions)}
          >
            <Zap className={`h-4 w-4 shrink-0 ${agentConnected ? "text-emerald-600" : "text-amber-600"}`} />
            <span className={`text-sm font-semibold flex-1 text-right ${agentConnected ? "text-emerald-900" : "text-amber-900"}`}>
              الوكيل المحلي (داخل مصر)
            </span>
            <span className={`text-xs font-medium flex items-center gap-1.5 ${agentConnected ? "text-emerald-700" : "text-amber-700"}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${agentConnected ? "bg-emerald-500 animate-pulse" : "bg-amber-400"}`} />
              {agentConnected ? "متصل ✓" : "غير متصل"}
            </span>
            {showAgentInstructions
              ? <ChevronUp className={`h-4 w-4 shrink-0 ${agentConnected ? "text-emerald-600" : "text-amber-600"}`} />
              : <ChevronDown className={`h-4 w-4 shrink-0 ${agentConnected ? "text-emerald-600" : "text-amber-600"}`} />
            }
          </button>

          {showAgentInstructions && (
            <CardContent className="px-5 pb-4 pt-0 space-y-3">
              {agentConnected ? (
                <div className="flex items-center gap-2 text-emerald-800 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  الوكيل المحلي متصل — سيتم الاستخراج من جهازك داخل مصر مباشرةً دون الحاجة لبروكسي.
                  {agentStatusData?.connectedAt && (
                    <span className="text-xs text-emerald-600 font-normal">
                      (منذ {new Date(agentStatusData.connectedAt).toLocaleTimeString("ar-EG")})
                    </span>
                  )}
                </div>
              ) : (
                <>
                  {/* ── Primary: Tampermonkey (no downloads, no admin) ── */}
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2.5">
                    <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                      <span className="bg-amber-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] shrink-0">✓</span>
                      الطريقة الأسهل — بدون تنزيل أي ملفات ولا صلاحيات Admin
                    </p>

                    {/* Step buttons */}
                    <div className="flex flex-col gap-2">
                      <a
                        href="https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-lg px-4 py-2 text-xs shadow transition-colors"
                      >
                        <span className="text-sm">①</span>
                        ثبّت Tampermonkey من Chrome Web Store
                        <span className="text-slate-400 text-[10px] font-normal mr-auto">(مجاني — بدون Admin)</span>
                      </a>

                      <a
                        href="/dl/agent.user.js"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg px-4 py-2 text-xs shadow transition-colors"
                      >
                        <span className="text-sm">②</span>
                        ثبّت سكريبت الوكيل — كليك واحد
                        <Download className="h-3.5 w-3.5 mr-auto" />
                      </a>
                    </div>

                    <div className="space-y-1 pt-0.5">
                      <p className="text-xs font-semibold text-amber-900">③ بعد التثبيت:</p>
                      <p className="text-xs text-amber-800">
                        افتح{" "}
                        <a
                          href="https://www.petrotrade.com.eg/web/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline font-medium"
                        >
                          petrotrade.com.eg
                        </a>
                        {" "}في تاب واتركه مفتوحاً — الوكيل سيتصل تلقائياً وستظهر رسالة{" "}
                        <span className="font-mono bg-amber-100 px-1 rounded text-[11px]">⚡ الوكيل: متصل ✓</span>
                        {" "}في أسفل يسار الصفحة.
                      </p>
                    </div>
                  </div>

                  {/* ── Secondary options (collapsed) ── */}
                  <details className="mt-1">
                    <summary className="text-xs text-amber-700 cursor-pointer select-none hover:text-amber-900 transition-colors">
                      خيارات أخرى (إضافة Chrome / Node.js)
                    </summary>
                    <div className="mt-2 space-y-2">
                      <a
                        href="/dl/browser-agent.zip"
                        download="browser-agent.zip"
                        className="inline-flex items-center gap-2 border border-amber-300 text-amber-800 hover:bg-amber-50 rounded-lg px-4 py-2 text-xs transition-colors"
                      >
                        <Download className="h-3.5 w-3.5" />
                        تحميل Chrome Extension (يتطلب Load unpacked)
                      </a>
                      <div className="bg-slate-900 rounded-lg p-3 font-mono text-xs text-green-400 space-y-1" dir="ltr">
                        <div className="text-slate-400"># Node.js local agent</div>
                        <div>npm install && node index.mjs --server <span className="text-yellow-300">{SERVER_WS_URL}</span></div>
                      </div>
                    </div>
                  </details>
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* Proxy Configuration Card (fallback) */}
        {!agentConnected && (
          <Card className="border-slate-200">
            <button
              className="w-full flex items-center gap-3 px-5 py-3.5 text-right"
              onClick={() => setShowProxySection(!showProxySection)}
            >
              <Wifi className="h-4 w-4 text-slate-500 shrink-0" />
              <span className="text-sm font-semibold text-slate-700 flex-1 text-right">
                البديل: بروكسي مصري
              </span>
              <span className="text-xs text-slate-500">
                {proxyUrl ? "✓ تم الإعداد" : "غير محدد"}
              </span>
              {showProxySection
                ? <ChevronUp className="h-4 w-4 text-slate-400 shrink-0" />
                : <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
              }
            </button>

            {showProxySection && (
              <CardContent className="px-5 pb-4 pt-0 space-y-3">
                <p className="text-sm text-slate-600">
                  إذا تعذّر تشغيل الوكيل المحلي، يمكنك استخدام بروكسي مصري بدلاً منه.
                </p>

                <div className="flex gap-2">
                  {!isSearching ? (
                    <Button
                      onClick={handleFindProxy}
                      disabled={findProxyMutation.isPending}
                      variant="outline"
                      className="text-sm h-9 px-4 flex items-center gap-2"
                    >
                      <Search className="h-4 w-4" />
                      بحث تلقائي عن بروكسي
                    </Button>
                  ) : (
                    <Button
                      onClick={handleCancelSearch}
                      variant="outline"
                      className="text-sm h-9 px-4 flex items-center gap-2"
                    >
                      <X className="h-4 w-4" />
                      إيقاف البحث
                    </Button>
                  )}
                </div>

                {proxySearchId && proxySearchData && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-700">
                        {searchStatus === "searching" && (
                          <span className="flex items-center gap-1.5">
                            <span className="h-3 w-3 rounded-full border-2 border-slate-400 border-t-transparent animate-spin inline-block" />
                            جاري البحث...
                          </span>
                        )}
                        {searchStatus === "found" && (
                          <span className="flex items-center gap-1.5 text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            تم العثور على بروكسي!
                          </span>
                        )}
                        {searchStatus === "not_found" && (
                          <span className="flex items-center gap-1.5 text-red-700">
                            <AlertCircle className="h-3.5 w-3.5" />
                            لم يُعثر على بروكسي يعمل
                          </span>
                        )}
                      </span>
                      {searchTotal > 0 && (
                        <span className="text-xs text-slate-500 font-mono">
                          {searchTested} / {searchTotal}
                        </span>
                      )}
                    </div>
                    {searchTotal > 0 && searchStatus === "searching" && (
                      <Progress value={searchProgress} className="h-1.5" />
                    )}
                    <p className="text-xs text-slate-600 leading-relaxed">{searchMessage}</p>
                    {searchStatus === "found" && proxySearchData.proxyUrl && (
                      <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-1.5">
                        <p className="text-xs text-emerald-700 font-mono break-all" dir="ltr">
                          {proxySearchData.proxyUrl}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-700">أو أدخل رابط البروكسي يدوياً</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={proxyUrl}
                      onChange={(e) => setProxyUrl(e.target.value)}
                      placeholder="http://username:password@proxy.example.com:8080"
                      className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 text-left"
                      dir="ltr"
                    />
                    {proxyUrl && (
                      <button
                        onClick={() => setProxyUrl("")}
                        className="text-slate-400 hover:text-slate-600 px-2"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        )}

            {/* Job failure warning */}
          {(isFailed || isNetworkError) && activeJobId && !agentConnected && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>فشل الاتصال بموقع بيتروتريد</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>الموقع محجوب من خارج مصر. شغّل الوكيل المحلي على جهازك أو استخدم بروكسي مصري ثم أعد المحاولة.</p>
                {errorSample && (
                  <p className="font-mono text-xs opacity-80 break-all mt-1">سبب الخطأ: {errorSample}</p>
                )}
              </AlertDescription>
            </Alert>
          )}
          {isFailed && activeJobId && !agentConnected && !isNetworkError && errorSample && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>فشل تشغيل السكريبر</AlertTitle>
              <AlertDescription className="font-mono text-xs break-all">{errorSample}</AlertDescription>
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
              {agentConnected && (
                <p className="text-xs text-emerald-600 font-medium mt-0.5 flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
                  سيتم الاستخراج عبر الوكيل المحلي داخل مصر
                </p>
              )}
            </div>

            <Button
              onClick={handleStartExtraction}
              disabled={isLoadingAccounts || isRunning || runScraperMutation.isPending || !accountsData?.count}
              className="w-full sm:w-auto bg-amber-500 hover:bg-amber-600 text-white font-bold h-11 px-8 shadow"
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
                                  ? "تعذر الوصول للموقع — شغّل الوكيل المحلي"
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
