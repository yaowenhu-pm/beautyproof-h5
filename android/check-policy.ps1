$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$classOutput = Join-Path $taskRoot 'build\policy-classes'
New-Item -ItemType Directory -Path $classOutput -Force | Out-Null
& javac --release 17 -encoding UTF-8 -d $classOutput (Join-Path $taskRoot 'app\src\main\java\com\beautyproof\trial\UrlPolicy.java') (Join-Path $taskRoot 'tests\UrlPolicyTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Policy compilation failed.' }
& java -cp $classOutput com.beautyproof.trial.UrlPolicyTest
if ($LASTEXITCODE -ne 0) { throw 'Policy tests failed.' }
