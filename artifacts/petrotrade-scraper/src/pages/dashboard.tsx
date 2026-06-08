import { useState } from "react";
import { 
  useGetAccounts, 
  useRunScraper, 
  useGetJobStatus,
  getGetJobStatusQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Building2, Download, Play, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

export default function Dashboard() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

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
      { data: {} },
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

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-6xl space-y-8">
        
        {/* Header */}
        <div className="flex items-center gap-4 border-b pb-6">
          <div className="h-16 w-16 bg-primary rounded-xl flex items-center justify-center shadow-lg shadow-primary/20">
            <Building2 className="h-8 w-8 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">مستخرج فواتير بيتروتريد</h1>
            <p className="text-slate-500 mt-1">نظام استخراج آلي لبيانات الاستهلاك والمطالبات</p>
          </div>
        </div>

        {/* Action Bar */}
        <Card className="shadow-sm border-slate-200">
          <CardContent className="p-6 flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-slate-900">التحكم بالعمليات</h2>
              <p className="text-sm text-slate-500 mt-1">
                {isLoadingAccounts ? (
                  "جاري تحميل الحسابات..."
                ) : accountsData ? (
                  `تم العثور على ${accountsData.count} حساب جاهز للاستخراج`
                ) : (
                  "لا توجد بيانات حسابات"
                )}
              </p>
            </div>
            
            <div className="flex items-center gap-4 w-full md:w-auto">
              <Button 
                onClick={handleStartExtraction} 
                disabled={isLoadingAccounts || isRunning || runScraperMutation.isPending || !accountsData?.count}
                className="w-full md:w-auto bg-amber-500 hover:bg-amber-600 text-primary-foreground font-bold shadow-md h-12 px-8"
                data-testid="button-start-extraction"
              >
                {runScraperMutation.isPending ? (
                  <span className="flex items-center gap-2">جاري الإطلاق...</span>
                ) : isRunning ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                    قيد الاستخراج
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Play className="h-5 w-5" />
                    بدء الاستخراج
                  </span>
                )}
              </Button>
            </div>
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

        {/* Progress Section */}
        {activeJobId && jobData && (
          <Card className="shadow-sm border-slate-200 overflow-hidden">
            <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
              <div className="flex justify-between items-center">
                <CardTitle className="text-lg">حالة العملية</CardTitle>
                <Badge 
                  variant={isCompleted ? "default" : isFailed ? "destructive" : "secondary"}
                  className={`
                    px-3 py-1 text-sm font-medium
                    ${isRunning ? 'bg-blue-100 text-blue-800 hover:bg-blue-100' : ''}
                    ${isCompleted ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : ''}
                  `}
                >
                  {isRunning && <Clock className="w-4 h-4 mr-1 ml-1.5 inline-block animate-pulse" />}
                  {isCompleted && <CheckCircle2 className="w-4 h-4 mr-1 ml-1.5 inline-block" />}
                  {isFailed && <AlertCircle className="w-4 h-4 mr-1 ml-1.5 inline-block" />}
                  {isRunning ? "قيد التشغيل" : isCompleted ? "مكتمل" : "فشل"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              <div className="space-y-6">
                <div className="flex justify-between items-end text-sm">
                  <span className="font-semibold text-slate-700">تقدم الاستخراج</span>
                  <span className="text-slate-500 font-mono font-medium bg-slate-100 px-3 py-1 rounded-md">
                    {jobData.processedAccounts} / {jobData.totalAccounts}
                  </span>
                </div>
                
                <Progress value={progressPercent} className="h-3" />
                
                {isCompleted && jobData.pdfReady && (
                  <div className="pt-4 flex justify-end">
                    <a 
                      href={`/api/scraper/pdf/${jobData.jobId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-10 px-6"
                      data-testid="link-download-pdf"
                    >
                      <Download className="ml-2 h-4 w-4" />
                      تحميل PDF
                    </a>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results Table */}
        {activeJobId && jobData?.results && jobData.results.length > 0 && (
          <Card className="shadow-sm border-slate-200">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">النتائج المستخرجة</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-50">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-right w-[150px] font-bold">رقم الحساب</TableHead>
                      <TableHead className="text-right font-bold">شهر الإصدار</TableHead>
                      <TableHead className="text-right font-bold">الاستهلاك</TableHead>
                      <TableHead className="text-right font-bold">تسوية مدينة</TableHead>
                      <TableHead className="text-right font-bold">رصيد دفعات مقدمة</TableHead>
                      <TableHead className="text-right font-bold">القيمة</TableHead>
                      <TableHead className="text-right font-bold">الحالة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobData.results.map((result, idx) => (
                      <TableRow 
                        key={`${result.accountNumber}-${idx}`}
                        className={result.status === "error" ? "bg-red-50/50" : ""}
                      >
                        <TableCell className="font-mono text-sm font-medium">{result.accountNumber}</TableCell>
                        <TableCell>{result.issueMonth || "-"}</TableCell>
                        <TableCell>{result.consumption || "-"}</TableCell>
                        <TableCell>{result.creditAdjustment || "-"}</TableCell>
                        <TableCell>{result.advanceBalance || "-"}</TableCell>
                        <TableCell className="font-semibold text-slate-900">{result.amount || "-"}</TableCell>
                        <TableCell>
                          {result.status === "success" && (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">ناجح</Badge>
                          )}
                          {result.status === "error" && (
                            <div className="flex flex-col gap-1">
                              <Badge variant="destructive" className="w-fit">خطأ</Badge>
                              <span className="text-xs text-red-600 truncate max-w-[200px]" title={result.error || ""}>
                                {result.error}
                              </span>
                            </div>
                          )}
                          {result.status === "pending" && (
                            <Badge variant="outline" className="text-slate-500">قيد الانتظار</Badge>
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