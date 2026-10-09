# Records every TCP connection owned by a process tree until a stop file appears (S3-07 network audit).
# Independent of Recall's own hooks: it asks Windows, not the app. Polls about 5 times a second, so a connection
# that opens and closes in between can be missed; the in-app guard and Chromium's net log cover those.
param([int]$RootPid, [string]$Out, [string]$StopFile)

$seen = @{}
$tree = @($RootPid)
$lastTree = [DateTime]::MinValue
New-Item -ItemType File -Force -Path $Out | Out-Null

while (-not (Test-Path $StopFile)) {
  if (([DateTime]::Now - $lastTree).TotalSeconds -ge 1) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
    $added = $true
    while ($added) {
      $added = $false
      foreach ($p in $all) {
        if (($tree -contains [int]$p.ParentProcessId) -and -not ($tree -contains [int]$p.ProcessId)) {
          $tree += [int]$p.ProcessId
          $added = $true
        }
      }
    }
    $lastTree = [DateTime]::Now
  }
  $conns = Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object { ($tree -contains [int]$_.OwningProcess) -and $_.State -ne 'Listen' -and $_.State -ne 'Bound' }
  foreach ($c in $conns) {
    $key = "$($c.OwningProcess) $($c.RemoteAddress) $($c.RemotePort)"
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      Add-Content -Path $Out -Value $key
    }
  }
  Start-Sleep -Milliseconds 200
}
