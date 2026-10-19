# Windows の GitHub Actions ランナーに SQL Server Express を入れる（CI 用）。
# 版は Microsoft の配布の最新版（2026-10 時点で 2025）。Linux のジョブは 2022 のコンテナなので、2 つの版を通すことになる。
# 既定のインスタンス（MSSQLSERVER）、TCP 1433、SQL 認証（sa）で、Linux のジョブの SQL Server のコンテナと同じ形にする。
# ランナーのイメージには SQL Server のエンジンがない（LocalDB は名前付きパイプだけで、Node の mssql からつなげない）。
#   pwsh .github/scripts/install-sqlserver.ps1 -SaPassword '...'
param(
  [Parameter(Mandatory = $true)] [string] $SaPassword
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$work = Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) 'sqlexpress'
New-Item -ItemType Directory -Force $work | Out-Null

# 案内役（SSEI）で中身（Core）だけを落とし、展開した setup.exe に SQL 認証と TCP を引数で渡す。
$ssei = Join-Path $work 'SQL-SSEI-Expr.exe'
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?linkid=2216019&clcid=0x409&culture=en-us&country=us' -OutFile $ssei
$p = Start-Process -FilePath $ssei -ArgumentList '/ACTION=Download', "/MEDIAPATH=$work", '/MEDIATYPE=Core', '/QUIET' -Wait -PassThru -NoNewWindow
$media = Get-ChildItem $work -Filter 'SQLEXPR*.exe' | Select-Object -First 1
if (-not $media) { throw "SQL Server Express の中身を落とせませんでした（exit $($p.ExitCode)）" }

$setupDir = Join-Path $work 'setup'
$p = Start-Process -FilePath $media.FullName -ArgumentList '/q', "/x:$setupDir" -Wait -PassThru -NoNewWindow
if (-not (Test-Path (Join-Path $setupDir 'setup.exe'))) { throw "SQL Server Express を展開できませんでした（exit $($p.ExitCode)）" }

$setupArgs = @(
  '/Q', '/ACTION=Install', '/FEATURES=SQLEngine', '/INSTANCENAME=MSSQLSERVER',
  '/SECURITYMODE=SQL', "/SAPWD=$SaPassword", '/TCPENABLED=1', '/NPENABLED=0',
  '/SQLSYSADMINACCOUNTS=BUILTIN\Administrators', '/UPDATEENABLED=0', '/IACCEPTSQLSERVERLICENSETERMS'
)
$p = Start-Process -FilePath (Join-Path $setupDir 'setup.exe') -ArgumentList $setupArgs -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) {
  Get-ChildItem "$env:ProgramFiles\Microsoft SQL Server\*\Setup Bootstrap\Log\Summary.txt" -ErrorAction SilentlyContinue | Get-Content
  throw "SQL Server のセットアップが失敗しました（exit $($p.ExitCode)）"
}

# 既定のインスタンスは 1433 で待つはずだが、動的ポートになっていたら 1433 に固定する。
$instance = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server' | Where-Object { $_.PSChildName -like 'MSSQL*.MSSQLSERVER' } | Select-Object -First 1
$ipAll = Join-Path $instance.PSPath 'MSSQLServer\SuperSocketNetLib\Tcp\IPAll'
$tcp = Get-ItemProperty $ipAll
Write-Host "SQL Server: $($instance.PSChildName), TcpPort=$($tcp.TcpPort), TcpDynamicPorts=$($tcp.TcpDynamicPorts)"
if ($tcp.TcpPort -ne '1433') {
  Set-ItemProperty $ipAll -Name TcpDynamicPorts -Value ''
  Set-ItemProperty $ipAll -Name TcpPort -Value '1433'
  Restart-Service MSSQLSERVER
}
