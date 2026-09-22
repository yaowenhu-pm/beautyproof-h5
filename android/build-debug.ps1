param([string]$SdkPath, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$javaHomeForTask = $env:JAVA_HOME
if (-not $javaHomeForTask -and (Get-Command java -ErrorAction SilentlyContinue)) {
    $propertyLine = (& java -XshowSettings:properties -version 2>&1 | ForEach-Object { $_.ToString() } | Where-Object { $_ -match '^\s*java\.home\s*=' } | Select-Object -First 1)
    if ($propertyLine) { $javaHomeForTask = ($propertyLine -replace '^\s*java\.home\s*=\s*', '').Trim() }
}
function Resolve-JavaTool([string]$Name) {
    $available = Get-Command $Name -ErrorAction SilentlyContinue
    if ($available) { return $available.Source }
    if ($javaHomeForTask) {
        $candidate = Join-Path $javaHomeForTask ('bin\' + $Name + '.exe')
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}
$taskSdk = $SdkPath
if (-not $taskSdk) { $taskSdk = $env:ANDROID_HOME }
if (-not $taskSdk) { $taskSdk = $env:ANDROID_SDK_ROOT }
if (-not $taskSdk) { $taskSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$missing = [System.Collections.Generic.List[string]]::new()
foreach ($command in @('java', 'javac', 'keytool')) {
    if (-not (Resolve-JavaTool $command)) { $missing.Add($command) }
}
foreach ($relative in @('platforms\android-35\android.jar', 'build-tools\35.0.0\aapt2.exe', 'build-tools\35.0.0\apksigner.bat', 'build-tools\35.0.0\zipalign.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskSdk $relative))) { $missing.Add($relative) }
}
New-Item -ItemType Directory -Path (Join-Path $taskRoot 'build') -Force | Out-Null
$result = [ordered]@{ checkedAt = [DateTimeOffset]::Now.ToString('o'); sdkPath = $taskSdk; missing = @($missing); apkProduced = $false; deviceInstalled = $false; downloadedSdk = $false }
if ($missing.Count -gt 0) {
    $result.status = 'toolchain_missing'
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRoot 'build\preflight.json') -Encoding utf8
    Write-Output ($result | ConvertTo-Json -Depth 4)
    exit 2
}
if ($CheckOnly) {
    $result.status = 'toolchain_present_not_built'
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRoot 'build\preflight.json') -Encoding utf8
    Write-Output ($result | ConvertTo-Json -Depth 4)
    exit 0
}
# No SDK installation, global settings, environment persistence, or device mutation.
$priorGradleCache = $env:GRADLE_USER_HOME
$priorAndroidHome = $env:ANDROID_HOME
try {
    $env:GRADLE_USER_HOME = Join-Path $taskRoot '.gradle-user'
    $env:ANDROID_HOME = $taskSdk
    $keyPath = Join-Path $taskRoot 'build\debug.keystore'
    if (-not (Test-Path -LiteralPath $keyPath)) {
        & (Resolve-JavaTool 'keytool') -genkeypair -noprompt -keystore $keyPath -storepass android -keypass android -alias androiddebugkey -dname 'CN=BeautyProof Local Debug,O=Development,C=CN' -keyalg RSA -keysize 2048 -validity 365
        if ($LASTEXITCODE -ne 0) { throw 'Local debug certificate generation failed.' }
    }
    Push-Location $taskRoot
    try { & .\gradlew.bat --no-daemon :app:assembleDebug; if ($LASTEXITCODE -ne 0) { throw 'Android compilation failed.' } }
    finally { Pop-Location }
    $apk = Join-Path $taskRoot 'app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle did not produce the expected APK.' }
    & (Join-Path $taskSdk 'build-tools\35.0.0\apksigner.bat') verify --verbose --print-certs $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    & (Join-Path $taskSdk 'build-tools\35.0.0\zipalign.exe') -c -v 4 $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment verification failed.' }
    $result.status = 'apk_built_and_signature_verified'
    $result.apkProduced = $true
    $result.apkPath = $apk
    $result.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $apk).Hash.ToLowerInvariant()
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRoot 'build\preflight.json') -Encoding utf8
    Write-Output ($result | ConvertTo-Json -Depth 4)
} finally {
    $env:GRADLE_USER_HOME = $priorGradleCache
    $env:ANDROID_HOME = $priorAndroidHome
}
