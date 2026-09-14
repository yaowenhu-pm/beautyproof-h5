# Historical v2.2 acceptance harness, executed on 2026-09-14.
# Do not rerun as part of free regression: this script can spend API budget.
# A new paid run requires a fresh explicit budget and updated version assertions.
param([switch]$SpendWithinApprovedBudget)
$ErrorActionPreference='Stop'
if(-not $SpendWithinApprovedBudget){throw 'Paid tests require explicit opt-in.'}
Add-Type -AssemblyName System.Security
$cipher=[Convert]::FromBase64String([IO.File]::ReadAllText((Join-Path $env:USERPROFILE '.beautyproof/secrets/test-admin.dpapi')))
$token=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
$headers=@{'x-beautyproof-test'=$token}
$origin='https://beautyproof-h5.yaowen-hu.chatgpt.site'
$before=Invoke-RestMethod "$origin/api/budget" -Headers $headers -TimeoutSec 20
$baseline=[long](($before.totals|Measure-Object accounted_micros -Sum).Sum)
if($before.price_version -ne 'deepseek-flash-2026-09-14-peak-2-8'){throw 'Production price revision not ready; no generation sent.'}
$resolved=Invoke-RestMethod "$origin/api/resolve" -Method Post -ContentType 'application/json' -Body '{"url":"https://xhslink.cn/o/1Kypa4Ly1nU"}' -TimeoutSec 25
$productionLinkReadable=[bool]($resolved.resolved -and $resolved.extraction.pageText)
if(-not $productionLinkReadable){
 # Same real page through the local resolver; never fake a production parsing pass.
 $resolved=Invoke-RestMethod 'http://localhost:3010/api/resolve' -Method Post -ContentType 'application/json' -Body '{"url":"https://xhslink.cn/o/1Kypa4Ly1nU"}' -TimeoutSec 25
}
if(-not $resolved.resolved -or -not $resolved.extraction.pageText){throw 'Real body unavailable in both environments; no paid calls sent.'}
$cases=@(
 @{id='medical';text='这块普通硫磺皂能治好湿疹，可以直接替代药膏。'},
 @{id='debunk';text='不要相信“硫磺皂能治好湿疹”，这只是清洁用品，不能代替药物。'},
 @{id='real-xhs-natural';text=$resolved.extraction.pageText}
)
$records=@()
foreach($case in $cases){
 $budget=Invoke-RestMethod "$origin/api/budget" -Headers $headers -TimeoutSec 20
 $used=[long](($budget.totals|Measure-Object accounted_micros -Sum).Sum)
 # Inputs below 1000 chars and bounded prompt/retrieval reserve < 50000 microyuan.
 if($case.text.Length -gt 1000 -or $used-$baseline+50000 -gt 100000){throw 'This-round conservative ceiling reached; no further request.'}
 $payload=@{sourceType='text';title=$case.id;extraction=@{pageText=$case.text}}
 if($case.id -eq 'real-xhs-natural'){$payload.sourceType='link';$payload.title=$resolved.title;$payload.canonicalUrl=$resolved.canonicalUrl;$payload.extraction.stages=@{page=@{status='complete'}};$payload.extraction.limitations=@('本次只测试公开正文；不包含视频、图片和评论')}
 $body=$payload|ConvertTo-Json -Depth 10 -Compress
 $timer=[Diagnostics.Stopwatch]::StartNew()
 $r=Invoke-RestMethod "$origin/api/analyze" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 65
 $report=$r.reportV2
 $passed=$report.status -eq 'complete' -and $report.version -eq '2.2'
 if($case.id -eq 'medical'){$passed=$passed -and @($report.findings|Where-Object {$_.judgment -eq 'risk' -and $_.citations -contains 'CN-AD11'}).Count -gt 0}
 if($case.id -eq 'debunk'){$passed=$passed -and @($report.findings|Where-Object judgment -eq 'risk').Count -eq 0}
 $record=@{id=$case.id;passed=$passed;ms=$timer.ElapsedMilliseconds;report=$report}
 $records+=$record
 $record|ConvertTo-Json -Depth 15 -Compress|Write-Output
 # A failed report is not auto-retried. Other independent cases may still be checked.
}
$after=Invoke-RestMethod "$origin/api/budget" -Headers $headers -TimeoutSec 20
$snapshot=$after|ConvertTo-Json -Depth 10 -Compress
$cached=Invoke-RestMethod "$origin/api/analyze" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 25
$final=Invoke-RestMethod "$origin/api/budget" -Headers $headers -TimeoutSec 20
$result=@{before=$before;after=$final;records=$records;productionLinkReadable=$productionLinkReadable;cacheReplay=$cached.reportV2.cached;budgetUnchanged=($snapshot -eq ($final|ConvertTo-Json -Depth 10 -Compress));deltaMicros=([long](($final.totals|Measure-Object accounted_micros -Sum).Sum)-$baseline)}
$outputDir=Join-Path $PSScriptRoot '../outputs'
[IO.Directory]::CreateDirectory($outputDir)|Out-Null
[IO.File]::WriteAllText((Join-Path $outputDir 'acceptance-2026-09-14.json'),($result|ConvertTo-Json -Depth 25))
$result|Select-Object cacheReplay,budgetUnchanged,deltaMicros,before,after|ConvertTo-Json -Depth 15
