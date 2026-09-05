param([switch]$SpendWithinApprovedBudget)
$ErrorActionPreference='Stop'
if(-not $SpendWithinApprovedBudget -or -not $env:BEAUTYPROOF_TEST_TOKEN){throw 'Explicit paid-test flag and private environment token required.'}
$origin='https://beautyproof-h5.yaowen-hu.chatgpt.site'
$headers=@{'x-beautyproof-test'=$env:BEAUTYPROOF_TEST_TOKEN}
$samples=@(
 @{id='moisturizer';text='这款普通面霜含甘油和透明质酸钠，主要用于日常保湿。实际感受因人而异，不承诺治疗皮肤疾病。';expect='not-risk'},
 @{id='medical';text='这款普通硫磺香皂治好了我的脱发和湿疹，三天就能治好，大家可以用它代替药膏。';expect='risk'},
 @{id='debunk';text='辟谣：不要相信“硫磺皂能治好脱发”的广告。普通清洁用品不能代替药物治疗，天然也不等于绝对安全。';expect='not-risk'}
)
foreach($sample in $samples){
 $budget=Invoke-RestMethod -Uri "$origin/api/budget" -Headers $headers -TimeoutSec 20
 $spent=($budget.totals|Where-Object purpose -eq 'test'|Measure-Object accounted_micros -Sum).Sum
 if($spent -ge 500000){throw 'Test budget pre-check stopped further calls.'}
 $timer=[Diagnostics.Stopwatch]::StartNew()
 $body=@{sourceType='text';title=$sample.text.Substring(0,[Math]::Min(52,$sample.text.Length));extraction=@{pageText=$sample.text}}|ConvertTo-Json -Depth 8 -Compress
 $result=Invoke-RestMethod -Method Post -Uri "$origin/api/analyze" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 65
 $hasRisk=@($result.reportV2.findings|Where-Object judgment -eq 'risk').Count -gt 0
 $passed=$result.reportV2.status -eq 'complete' -and $(if($sample.expect -eq 'risk'){$hasRisk}else{-not $hasRisk})
 @{id=$sample.id;ms=$timer.ElapsedMilliseconds;semanticPass=$passed;report=$result.reportV2}|ConvertTo-Json -Depth 15 -Compress|Write-Output
 if(-not $passed){Write-Output 'Stopped for manual review. No automatic paid retry.';break}
}
Invoke-RestMethod -Uri "$origin/api/budget" -Headers $headers -TimeoutSec 20|ConvertTo-Json -Depth 10 -Compress|Write-Output
