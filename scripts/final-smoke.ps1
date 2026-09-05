param([switch]$SpendWithinApprovedBudget)
$ErrorActionPreference='Stop'
if(-not $SpendWithinApprovedBudget -or -not $env:BEAUTYPROOF_TEST_TOKEN){throw 'Explicit paid-test flag and private environment token required.'}
$origin='https://beautyproof-h5.yaowen-hu.chatgpt.site'
$headers=@{'x-beautyproof-test'=$env:BEAUTYPROOF_TEST_TOKEN}
$medical='这款普通硫磺香皂治好了我的脱发和湿疹，三天就能治好，大家可以用它代替药膏。'
# Actual Tesseract output from the synthetic PNG fixture; spacing preserved.
$ocr="测试 标签 (虚构 产品 ， 仪 供 流程 验收 )`n`n成 分 : 水 、 甘 油 、 烟 酰胺 、 泛 醇 、 透 明 质 酸 钠 。`n用 途 : 日 常 保湿 。`n`n不 宣称 治疗 疾病 ; 请 勿 当 作 实际 产 品 检测 报告 。"
$resolved=Invoke-RestMethod -Uri "$origin/api/resolve" -Method Post -ContentType 'application/json' -Body '{"url":"https://xhslink.cn/o/1Kypa4Ly1nU"}' -TimeoutSec 25
if(-not $resolved.resolved -or -not $resolved.extraction.pageText){throw 'Public sample unavailable; no paid request sent.'}
$cases=@(
 @{id='medical-fixed';payload=@{sourceType='text';title=$medical.Substring(0,[Math]::Min(52,$medical.Length));extraction=@{pageText=$medical}}},
 @{id='ocr-label';payload=@{sourceType='upload';title='ingredient-label-fixture.png';ingredientLabel=$true;extraction=@{ocrText=$ocr;frameCount=1;stages=@{ocr=@{status='complete';detail='真实Tesseract测试图片识别'}}}}},
 @{id='xhs-natural';payload=@{sourceType='link';title=$resolved.title;canonicalUrl=$resolved.canonicalUrl;extraction=@{pageText=$resolved.extraction.pageText;stages=@{page=@{status='complete';detail='平台正文'}};limitations=@('本次验收仅分析公开正文，未分析媒体内容')};resolver=@{resolved=$true}}}
)
$records=@()
foreach($case in $cases){
 $budget=Invoke-RestMethod -Uri "$origin/api/budget" -Headers $headers -TimeoutSec 20
 $spent=($budget.totals|Where-Object purpose -eq 'test'|Measure-Object accounted_micros -Sum).Sum
 if($spent -ge 500000){throw 'Test budget pre-check stopped further calls.'}
 $timer=[Diagnostics.Stopwatch]::StartNew();$body=$case.payload|ConvertTo-Json -Depth 10 -Compress
 $r=Invoke-RestMethod -Uri "$origin/api/analyze" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 65
 $passed=$r.reportV2.status -eq 'complete' -and $r.reportV2.kbVersion -eq '2026-09-06.2'
 if($case.id -eq 'medical-fixed'){$passed=$passed -and @($r.reportV2.findings|Where-Object {$_.judgment -eq 'risk' -and $_.citations -contains 'CN-AD11'}).Count -gt 0}
 if($case.id -eq 'ocr-label'){$passed=$passed -and $r.reportV2.ingredients.Count -eq 5 -and @($r.reportV2.ingredients|Where-Object origin -ne 'label').Count -eq 0}
 $record=@{id=$case.id;ms=$timer.ElapsedMilliseconds;passed=$passed;report=$r.reportV2;extraction=$r.extraction};$records+=$record
 @{id=$case.id;ms=$timer.ElapsedMilliseconds;passed=$passed;summary=$r.reportV2.summary;findings=$r.reportV2.findings;ingredients=$r.reportV2.ingredients|Select-Object cn,quote,origin}|ConvertTo-Json -Depth 10 -Compress|Write-Output
 if(-not $passed){Write-Output 'Stopped for manual review. No automatic paid retry.';break}
}
$before=Invoke-RestMethod -Uri "$origin/api/budget" -Headers $headers -TimeoutSec 20
# Replay final exact request: must hit cache, not a paid retry.
$cached=Invoke-RestMethod -Uri "$origin/api/analyze" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
$after=Invoke-RestMethod -Uri "$origin/api/budget" -Headers $headers -TimeoutSec 20
@{cached=$cached.reportV2.cached;budgetUnchanged=($before|ConvertTo-Json -Depth 8 -Compress) -eq ($after|ConvertTo-Json -Depth 8 -Compress);budget=$after}|ConvertTo-Json -Depth 10 -Compress|Write-Output
$outputDir=Join-Path $PSScriptRoot '..\outputs';[IO.Directory]::CreateDirectory($outputDir)|Out-Null
[IO.File]::WriteAllText((Join-Path $outputDir 'final-smoke.json'),(@{records=$records;budget=$after}|ConvertTo-Json -Depth 20))
