# The MSIX package of the Windows app, for the Microsoft Store: entre-nous.exe (built by
# `tauri build`), the logos and the manifest, indexed (resources.pri) and packed with the tools
# of the Windows SDK. Not signed: the Store signs it. Run on Windows (the CI does it):
#   desktop/msix/build.ps1 -Exe <entre-nous.exe> -Version 0.1.55 -Out Entre-Nous-windows.msix [-Check]
# The identity comes from Partner Center (Product identity), in MSIX_IDENTITY_NAME,
# MSIX_PUBLISHER and MSIX_PUBLISHER_NAME; without it, a placeholder, enough to check the package.
# -Check: signs a copy with a throwaway certificate, installs it and starts it (then removes it).
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Out,
  [switch] $Check
)
$ErrorActionPreference = 'Stop'

function Setting($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($v) { $v } else { $default }
}
$identity = Setting 'MSIX_IDENTITY_NAME' 'EntreNous'
$publisher = Setting 'MSIX_PUBLISHER' 'CN=Entre Nous'
$publisherName = Setting 'MSIX_PUBLISHER_NAME' 'Entre Nous'

# the tools of the newest Windows SDK
$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\makeappx.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK not found (makeappx.exe)' }
$tools = $sdk.DirectoryName
function Run($exe) {
  & (Join-Path $tools $exe) @args
  if ($LASTEXITCODE) { throw "$exe failed ($LASTEXITCODE)" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) 'entrenous-msix'
$layout = Join-Path $work 'layout'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $layout | Out-Null
Copy-Item $Exe (Join-Path $layout 'entre-nous.exe')
Copy-Item (Join-Path $PSScriptRoot 'Assets') (Join-Path $layout 'Assets') -Recurse

# 0.1.55 -> 0.1.55.0: the Store keeps the fourth number for itself
$esc = { param($s) [Security.SecurityElement]::Escape($s) }
$manifest = (Get-Content (Join-Path $PSScriptRoot 'AppxManifest.xml') -Raw).
  Replace('$IdentityName$', (& $esc $identity)).
  Replace('$Publisher$', (& $esc $publisher)).
  Replace('$PublisherDisplayName$', (& $esc $publisherName)).
  Replace('$Version$', "$Version.0")
Set-Content (Join-Path $layout 'AppxManifest.xml') $manifest -Encoding utf8

# resources.pri: the logo of each size (scale, taskbar sizes without a plate) found by Windows;
# all in one file (no resource packs: the package is not a bundle)
$priconfig = Join-Path $work 'priconfig.xml'
Run makepri.exe createconfig /cf $priconfig /dq en-US /pv 10.0.0 /o
[xml]$cfg = Get-Content $priconfig
$packaging = $cfg.resources.SelectSingleNode('packaging')
if ($packaging) { [void]$cfg.resources.RemoveChild($packaging) }
$cfg.Save($priconfig)
Run makepri.exe new /pr $layout /cf $priconfig /mn (Join-Path $layout 'AppxManifest.xml') /of (Join-Path $layout 'resources.pri') /o

Run makeappx.exe pack /d $layout /p $Out /o
Write-Host "Built: $Out ($identity $Version.0)"

if (-not $Check) { return }

# Check: installed and started like the Store would (signed here by a throwaway certificate
# of the same publisher, trusted on this machine only)
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
  -FriendlyName 'Entre Nous (check)' -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$cer = Join-Path $work 'check.cer'
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
$signed = Join-Path $work 'check.msix'
Copy-Item $Out $signed
Run signtool.exe sign /fd SHA256 /sha1 $cert.Thumbprint $signed
Add-AppxPackage $signed
$pkg = Get-AppxPackage -Name $identity
if (-not $pkg) { throw 'package not installed' }
try {
  Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!EntreNous"
  $running = $false
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 1
    if (Get-Process entre-nous -ErrorAction SilentlyContinue) { $running = $true; break }
  }
  if ($running) {
    Start-Sleep -Seconds 5 # still there: it did not crash at start
    if (-not (Get-Process entre-nous -ErrorAction SilentlyContinue)) { throw 'the app quit at start' }
    Write-Host "Checked: $($pkg.PackageFullName) installs and runs"
  } else {
    # no desktop to start it in: the install is checked, not the start
    Write-Host "::warning::MSIX installed, but the app could not be started here"
  }
} finally {
  Get-Process entre-nous -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-AppxPackage $pkg.PackageFullName
}
