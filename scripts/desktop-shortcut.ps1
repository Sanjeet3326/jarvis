# Puts a "JARVIS" icon on the desktop and in the Start menu that opens the
# desktop app (electron/main.cjs). Run with: npm run desktop:shortcut
# Pass -Writes to make the shortcut start JARVIS with PC actions allowed.
param([switch]$Writes)

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
  Write-Error "Electron is not installed yet. Run: npm install; node node_modules\electron\install.js"
  exit 1
}

$arguments = "`"$root`""
if ($Writes) { $arguments += ' --writes' }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'JARVIS.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'JARVIS.lnk')
)
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = $exe
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $root 'electron\icon.ico')
  $lnk.Description = 'J.A.R.V.I.S. - say "Hey Saji"'
  $lnk.Save()
  Write-Output "created $t"
}
