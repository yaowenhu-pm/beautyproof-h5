# Generates a local DPAPI-protected admin test credential, never placed in the repository.
# Stdout is for the deployment orchestrator only; never log or publish it.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$secretDir=Join-Path $env:USERPROFILE '.beautyproof/secrets'
[IO.Directory]::CreateDirectory($secretDir)|Out-Null
$testSecret=([Guid]::NewGuid().ToString('N'))+([Guid]::NewGuid().ToString('N'))
$protected=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($testSecret),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText((Join-Path $secretDir 'test-admin.dpapi'),[Convert]::ToBase64String($protected))
[Console]::Write($testSecret)
