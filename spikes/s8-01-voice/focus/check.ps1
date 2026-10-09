Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
public static string Title() { var s = new StringBuilder(256); GetWindowText(GetForegroundWindow(), s, 256); return s.ToString(); } }
"@
$np = Start-Process notepad -PassThru
Start-Sleep -Milliseconds 1500
[W]::SetForegroundWindow($np.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
"before: " + [W]::Title()
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$e = Start-Process -FilePath $args[0] -ArgumentList $args[1] -PassThru -WindowStyle Normal
$titles = @()
for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 250; $titles += [W]::Title() }
"during: " + (($titles | Select-Object -Unique) -join ' | ')
$e.WaitForExit(5000) | Out-Null
Stop-Process -Id $np.Id -Force
