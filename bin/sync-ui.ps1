<#
  Copies the shared web UI (the Windows build is the source of truth) into the Android
  assets folder, laid out so the SAME index.html resolves on Android:

      assets/index.html            <- /index.html
      assets/app.js, app.css       <- /app.js, /app.css
      assets/lib/*                 <- /lib/*
      assets/public/update-banner.js  <- /public/update-banner.js  (index.html uses this path)
      assets/android-bridge.js     (Android-only, injected by the shell - not referenced by HTML)
#>
$ErrorActionPreference = 'Stop'
$Android = Split-Path -Parent $PSScriptRoot
$Src     = "C:\Shepherd\Work Stuff\App Builds\Shepherd MD"
$Assets  = Join-Path $Android 'app\src\main\assets'

New-Item -ItemType Directory -Force -Path (Join-Path $Assets 'public') | Out-Null

foreach ($f in 'index.html', 'app.js', 'app.css') {
  Copy-Item (Join-Path $Src "public\$f") -Destination (Join-Path $Assets $f) -Force
}
Copy-Item (Join-Path $Src 'public\update-banner.js') -Destination (Join-Path $Assets 'public\update-banner.js') -Force

$libDst = Join-Path $Assets 'lib'
if (Test-Path $libDst) { Remove-Item -LiteralPath $libDst -Recurse -Force }
Copy-Item (Join-Path $Src 'lib') -Destination $libDst -Recurse -Force

foreach ($f in 'favicon.ico', 'icon-192.png', 'icon-256.png', 'icon-512.png', 'icon.svg', 'manifest.webmanifest') {
  Copy-Item (Join-Path $Src $f) -Destination (Join-Path $Assets $f) -Force
}

Write-Host "UI synced into Android assets:" -ForegroundColor Green
Get-ChildItem $Assets | Select-Object Name | Format-Table -AutoSize
