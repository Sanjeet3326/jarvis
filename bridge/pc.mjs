import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { randomInt } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

/**
 * Your PC, as a short list of things JARVIS can do to it.
 *
 * Not a shell. JARVIS_ALLOW_WRITES hands the model Bash, which can do anything
 * and so has to stay off by default. These are a dozen named actions, each one
 * PowerShell written here, with the model's words passed in as environment
 * variables rather than pasted into the script — so "open notepad; format c:"
 * is just an app name that matches nothing.
 *
 * Two tiers:
 *   - Harmless or easily undone (open an app, volume, a screenshot, lock): run.
 *   - Loses work or is hard to undo (shut down, restart, sleep, sign out, send
 *     to the Recycle Bin): refused until the USER says yes. The first call hands
 *     back a code; a second call with that code only succeeds once a new thing
 *     has been heard from the user and it was a yes. The model cannot answer
 *     for them — the check reads what the microphone heard, not what it says.
 *
 * Windows only; on anything else the server is simply not offered.
 */

/** Run a PowerShell script. Values go in as $env:JP_* so nothing is quoted into code. */
function ps(script, env = {}, timeoutMs = 20000) {
  const vars = Object.fromEntries(Object.entries(env).map(([k, v]) => [`JP_${k}`, String(v ?? '')]))
  const encoded = Buffer.from(
    `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'\n${script}`,
    'utf16le',
  ).toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...vars }, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(psError(stderr.toString()) || (err.killed ? 'timed out' : 'PowerShell failed')))
        else resolve(stdout.toString().trim())
      },
    )
  })
}

/** The first line of a PowerShell error, out of the CLIXML it is wrapped in. */
function psError(stderr) {
  const parts = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1].replace(/_x000D__x000A_/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  )
  const text = parts.length ? parts.join('') : stderr
  return text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#< CLIXML')) ?? ''
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const guard = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (err) {
    return fail(`Failed: ${err.message}`)
  }
}

// ------------------------------------------------------------------ scripts

const KEYS = `
Add-Type -Namespace JP -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'
function Tap([byte]$k) { [JP.Keys]::keybd_event($k,0,0,[UIntPtr]::Zero); [JP.Keys]::keybd_event($k,0,2,[UIntPtr]::Zero) }
`

const AUDIO = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class JPAudio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice d = null; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
    IAudioEndpointVolume v = null; var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(d.Activate(ref id, 23, 0, out v)); return v;
  }
  public static float Volume { get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, System.Guid.Empty)); } }
  public static bool Mute { get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, System.Guid.Empty)); } }
}
'@
`

/** Folders a spoken name can mean. */
const FOLDERS = `
$f = @{
  desktop = [Environment]::GetFolderPath('Desktop'); documents = [Environment]::GetFolderPath('MyDocuments')
  downloads = Join-Path $env:USERPROFILE 'Downloads'; pictures = [Environment]::GetFolderPath('MyPictures')
  videos = [Environment]::GetFolderPath('MyVideos'); music = [Environment]::GetFolderPath('MyMusic')
  home = $env:USERPROFILE
}
if ($env:OneDrive) { $f.onedrive = $env:OneDrive }
function Resolve-Spoken([string]$p) {
  $p = $p.Trim().Trim('"')
  $key = $p.ToLower() -replace '\\s*folder$',''
  if ($f.ContainsKey($key)) { return $f[$key] }
  $first, $rest = $p -split '[\\\\/]', 2
  if ($f.ContainsKey($first.ToLower())) { if ($rest) { return Join-Path $f[$first.ToLower()] $rest } else { return $f[$first.ToLower()] } }
  if ($p.StartsWith('~')) { return Join-Path $env:USERPROFILE $p.Substring(1).TrimStart('\\','/') }
  return $p
}
function Inside-Profile([string]$full) {
  $root = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\\') + '\\'
  return ([IO.Path]::GetFullPath($full) + '\\').StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
}
`

/** Spoken names for Settings pages and a few built-ins Get-StartApps lists oddly. */
const SPECIAL = {
  settings: 'ms-settings:',
  'wifi settings': 'ms-settings:network-wifi',
  'wi-fi settings': 'ms-settings:network-wifi',
  wifi: 'ms-settings:network-wifi',
  'bluetooth settings': 'ms-settings:bluetooth',
  bluetooth: 'ms-settings:bluetooth',
  'display settings': 'ms-settings:display',
  'sound settings': 'ms-settings:sound',
  'battery settings': 'ms-settings:batterysaver',
  'windows update': 'ms-settings:windowsupdate',
  'apps settings': 'ms-settings:appsfeatures',
  'file explorer': 'explorer.exe',
  explorer: 'explorer.exe',
  'task manager': 'taskmgr.exe',
}

const RISKY_EXT = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|hta|cpl|reg|jar|lnk|url)$/i

// ------------------------------------------------------------- confirmation

const YES = /\b(yes|yeah|yep|yup|ya|sure|ok|okay|do it|go ahead|go for it|confirm(ed)?|proceed|please do|affirmative|absolutely|haan|han|haa|ha ji|theek hai|kar do)\b/i
const NO = /\b(no|nope|nah|don'?t|do not|cancel|stop|wait|never ?mind|nahi|nahin|mat)\b/i

/**
 * @param {{ heard: () => { turn: number, text: string } }} options
 *   heard() reports what the user last said and how many things they have said
 *   on this connection. It is read from the microphone side of the bridge.
 */
export function pcServer({ heard }) {
  return createSdkMcpServer({
    name: 'jarvis_pc',
    version: '1.0.0',
    instructions:
      'Control of the Windows PC SAJI runs on: apps, volume, media, brightness, screenshot, lock, ' +
      'battery/status, finding and opening the user\'s files, folders, Recycle Bin and power. ' +
      'pc_recycle and pc_power (except cancel) require the user\'s spoken yes via a confirmation code.',
    alwaysLoad: true,
    tools: pcTools({ heard }),
  })
}

/** The tool definitions on their own, so they can be exercised without an MCP host. */
export function pcTools({ heard }) {
  /** code -> { key, turn, at } */
  const pending = new Map()

  function confirmGate(action, args, question) {
    const key = JSON.stringify([action, { ...args, confirm: undefined }])
    const code = args.confirm ? String(args.confirm).trim() : ''
    if (!code) {
      const c = String(randomInt(1000, 9999))
      pending.set(c, { key, turn: heard().turn, at: Date.now() })
      return ok(
        `NOT DONE YET — this needs the user's spoken yes. Ask them in one short sentence: "${question}" ` +
          `Then stop and wait. If they say yes, call this tool again with exactly the same arguments plus confirm: "${c}". ` +
          'If they say no or anything else, drop it.',
      )
    }
    const p = pending.get(code)
    if (!p || p.key !== key || Date.now() - p.at > 120000) {
      pending.delete(code)
      return fail('That confirmation code is not valid for this action (or expired). Call again without confirm to ask afresh.')
    }
    const now = heard()
    if (now.turn <= p.turn) return fail('The user has not answered yet. Ask them and wait for their reply.')
    if (!YES.test(now.text) || NO.test(now.text)) {
      pending.delete(code)
      return fail(`The user did not say yes (they said "${now.text.slice(0, 80)}"). Not done. Drop it unless they ask again.`)
    }
    pending.delete(code)
    return null
  }

  const tools = [
    tool(
      'pc_status',
      'Battery level and charging, CPU load, memory, free disk space, uptime and current volume of this PC. Use for "what\'s my battery", "how\'s my laptop doing", "how much space is left".',
      {},
      guard(async () => {
        const out = await ps(
          AUDIO +
            `
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
$disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | % { @{ drive=$_.DeviceID; freeGB=[math]::Round($_.FreeSpace/1GB,1); sizeGB=[math]::Round($_.Size/1GB,0) } }
$vol = $null; $mute = $null; try { $vol = [math]::Round([JPAudio]::Volume*100); $mute = [JPAudio]::Mute } catch {}
@{
  battery = if ($b) { @{ percent=$b.EstimatedChargeRemaining; pluggedIn=($b.BatteryStatus -in 2,6,7,8,9) } } else { 'no battery' }
  cpuPercent = $cpu
  memory = @{ usedGB=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1); totalGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1) }
  disks = @($disks)
  uptimeHours = [math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)
  volumePercent = $vol; muted = $mute
} | ConvertTo-Json -Compress -Depth 4`,
        )
        return ok(out)
      }),
    ),

    tool(
      'pc_open_app',
      'Open an app installed on this PC by its name as said aloud ("Spotify", "VS Code", "WhatsApp", "calculator", "Word"), or a Settings page ("wifi settings", "bluetooth", "display settings", "sound settings"). For websites use the chrome tools instead.',
      { name: z.string().min(1).max(80).describe('The app name, as the user said it.') },
      guard(async ({ name }) => {
        const special = SPECIAL[name.trim().toLowerCase()]
        if (special) {
          await ps(`Start-Process $env:JP_TARGET`, { TARGET: special })
          return ok(`Opened ${name}.`)
        }
        const out = await ps(
          `
$q = $env:JP_NAME.ToLower().Trim()
$words = $q -split '\\s+' | ? { $_ }
$apps = Get-StartApps | ? { $_.Name -notmatch '^(Uninstall|Install |Release Notes|Documentation|readme|license)' }
$scored = foreach ($a in $apps) {
  $n = $a.Name.ToLower(); $s = 0
  if ($n -eq $q) { $s = 100 } elseif ($n.StartsWith($q)) { $s = 80 } elseif ($n.Contains($q)) { $s = 60 }
  else { $hit = @($words | ? { $n.Contains($_) }).Count; if ($hit -eq $words.Count) { $s = 50 } elseif ($hit) { $s = 10*$hit } }
  $init = (($a.Name -split '[\\s\\-]+' | ? { $_ } | % { $_[0] }) -join '').ToLower()
  if ($s -lt 70 -and $init -eq ($q -replace '\\s','')) { $s = 70 }
  if ($s) { [pscustomobject]@{ s=$s - $n.Length/100; name=$a.Name; id=$a.AppID } }
}
$best = $scored | Sort-Object s -Descending | Select-Object -First 4
if (-not $best -or $best[0].s -lt 40) { @{ opened=$null; suggestions=@($best | % name) } | ConvertTo-Json -Compress; exit }
Start-Process ("shell:AppsFolder\\" + $best[0].id)
@{ opened=$best[0].name } | ConvertTo-Json -Compress`,
          { NAME: name },
        )
        const r = JSON.parse(out || '{}')
        if (r.opened) return ok(`Opened ${r.opened}.`)
        return fail(
          r.suggestions?.length
            ? `No app clearly called "${name}". Closest: ${r.suggestions.join(', ')}. Ask which one they meant.`
            : `No installed app called "${name}".`,
        )
      }),
    ),

    tool(
      'pc_close_app',
      'Close an app\'s windows politely, as if its close button were clicked — it can still ask to save. Matches the app or window name ("Spotify", "Notepad", "Word"). Cannot close SAJI or the Windows shell.',
      { name: z.string().min(2).max(80) },
      guard(async ({ name }) => {
        const out = await ps(
          `
$q = $env:JP_NAME.ToLower().Trim()
$skip = 'electron','explorer','dwm','winlogon','csrss','svchost','lsass','services','system','idle','powershell','node'
$p = Get-Process | ? { $_.MainWindowHandle -ne 0 -and $skip -notcontains $_.ProcessName.ToLower() -and $_.MainWindowTitle -notin 'J.A.R.V.I.S.','S.A.J.I.' -and ($_.ProcessName.ToLower().Contains($q.Replace(' ','')) -or $_.MainWindowTitle.ToLower().Contains($q)) }
$closed = @($p | % { $null = $_.CloseMainWindow(); "$($_.ProcessName): $($_.MainWindowTitle)" })
@{ closed=$closed } | ConvertTo-Json -Compress`,
          { NAME: name },
        )
        const r = JSON.parse(out || '{}')
        const list = [].concat(r.closed ?? [])
        return list.length ? ok(`Asked to close: ${list.join('; ')}.`) : fail(`No open window matching "${name}".`)
      }),
    ),

    tool(
      'pc_volume',
      'Change the PC\'s sound volume: set to a level, turn it up or down, mute or unmute.',
      {
        action: z.enum(['set', 'up', 'down', 'mute', 'unmute']),
        level: z.number().min(0).max(100).optional().describe('For set: 0-100. For up/down: how much (default 10).'),
      },
      guard(async ({ action, level }) => {
        const out = await ps(
          AUDIO +
            `
$a = $env:JP_ACTION; $l = [double]$env:JP_LEVEL
$v = [double][JPAudio]::Volume
# 1.0 and 0.0, not 1 and 0: [math]::Min(1, 0.23) picks the integer overload
# and rounds the volume to 0% or 100%.
switch ($a) {
  'set' { [JPAudio]::Volume = [math]::Min(1.0,[math]::Max(0.0,$l/100)); [JPAudio]::Mute = $false }
  'up' { [JPAudio]::Volume = [math]::Min(1.0,$v + $l/100); [JPAudio]::Mute = $false }
  'down' { [JPAudio]::Volume = [math]::Max(0.0,$v - $l/100) }
  'mute' { [JPAudio]::Mute = $true }
  'unmute' { [JPAudio]::Mute = $false }
}
@{ volumePercent=[math]::Round([JPAudio]::Volume*100); muted=[JPAudio]::Mute } | ConvertTo-Json -Compress`,
          { ACTION: action, LEVEL: level ?? (action === 'set' ? 50 : 10) },
        )
        return ok(out)
      }),
    ),

    tool(
      'pc_media',
      'Media keys for whatever is playing (Spotify, YouTube in a browser, VLC...): play/pause, next track, previous track, stop.',
      { action: z.enum(['play_pause', 'next', 'previous', 'stop']) },
      guard(async ({ action }) => {
        const vk = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 }[action]
        await ps(KEYS + `Tap ${vk}`)
        return ok(`Pressed ${action.replace('_', '/')}.`)
      }),
    ),

    tool(
      'pc_brightness',
      'Set the laptop screen brightness (0-100), or read it when level is left out.',
      { level: z.number().min(0).max(100).optional() },
      guard(async ({ level }) => {
        const out = await ps(
          `
if ($env:JP_LEVEL) { Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout=1; Brightness=[byte]$env:JP_LEVEL } | Out-Null; Start-Sleep -Milliseconds 300 }
@{ brightnessPercent=(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness } | ConvertTo-Json -Compress`,
          { LEVEL: level ?? '' },
        )
        return ok(out)
      }),
    ),

    tool(
      'pc_screenshot',
      'Take a screenshot of the whole screen and save it to Pictures\\SAJI. Returns where it was saved.',
      {},
      guard(async () => {
        const out = await ps(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace JP -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[JP.Dpi]::SetProcessDPIAware() | Out-Null
$r = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $r.Width, $r.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size); $g.Dispose()
$dir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'SAJI'; New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir ("screenshot-" + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') + ".png")
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
$file`)
        return ok(`Saved to ${out}`)
      }),
    ),

    tool(
      'pc_lock',
      'Lock the PC (the Windows lock screen). Nothing is closed or lost.',
      {},
      guard(async () => {
        await ps(`rundll32.exe user32.dll,LockWorkStation`)
        return ok('Locked.')
      }),
    ),

    tool(
      'pc_find_files',
      'Search the user\'s own folders (Desktop, Documents, Downloads, Pictures, Videos, Music, OneDrive) for files or folders whose name contains the given words. Use for "find my CV", "where is the report I downloaded". Newest first.',
      {
        query: z.string().min(1).max(80).describe('Words from the file name, e.g. "cv" or "resume pdf".'),
        limit: z.number().min(1).max(30).optional(),
      },
      guard(async ({ query, limit }) => {
        const out = await ps(
          FOLDERS +
            `
# Words must start a word in the name: "cv" finds "My_CV.pdf", not "ClassicValue".
$all = @($env:JP_QUERY.ToLower() -replace '[^a-z0-9._ -]',' ' -split '\\s+' | ? { $_ })
$ext = @($all | ? { $_ -match '^\\.?(pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g|gif|mp4|mkv|mp3|wav|zip|rar)$' } | % { $_.TrimStart('.') })
$words = @($all | ? { $ext -notcontains $_.TrimStart('.') })
if (-not $words.Count -and -not $ext.Count) { throw 'Say part of the file name.' }
$noise = '\\\\(appdata|node_modules|\\.git|\\.venv|venv|__pycache__|site-packages|\\$recycle\\.bin|dist|build|out|\\.next|target|bin|obj)(\\\\|$)'
# Source and build files from coding projects drown the documents people mean.
$codeExt = 'js','mjs','cjs','ts','tsx','jsx','map','woff','woff2','ttf','pyc','dll','so','o','obj','class','lock','d.ts','css','scss','json','yml','yaml','toml','h','c','cpp','py','ino','java','go','rs'
function Test-Name([string]$p, [bool]$isDir) {
  $n = [IO.Path]::GetFileName($p).ToLower()
  foreach ($w in $words) { if ($n -notmatch ('(^|[^a-z0-9])' + [regex]::Escape($w))) { return $false } }
  $e = [IO.Path]::GetExtension($n).TrimStart('.')
  if ($ext.Count) { if ($isDir) { return $false }; if (-not ($ext | ? { $e -eq $_ -or ($e -eq $_ + 'x') })) { return $false } }
  elseif (-not $isDir -and $codeExt -contains $e) { return $false }
  return ($p -notmatch $noise)
}
$hits = New-Object System.Collections.ArrayList
$how = 'index'
try {
  # The Windows Search index: the same thing the Start menu searches, and instant.
  $cond = @($words | % { "System.FileName LIKE '%$($_.Replace("'",''))%'" })
  $sql = "SELECT TOP 400 System.ItemPathDisplay, System.ItemType FROM SystemIndex WHERE SCOPE='file:$($env:USERPROFILE)'" + $(if ($cond.Count) { ' AND ' + ($cond -join ' AND ') } else { '' }) + $(if ($ext.Count) { ' AND (' + (($ext | % { "System.FileExtension = '.$_' OR System.FileExtension = '.$($_)x'" }) -join ' OR ') + ')' } else { '' }) + ' ORDER BY System.DateModified DESC'
  $conn = New-Object -ComObject ADODB.Connection; $rs = New-Object -ComObject ADODB.Recordset
  $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $rs.Open($sql, $conn)
  while (-not $rs.EOF) {
    $p = $rs.Fields.Item('System.ItemPathDisplay').Value
    if ($p -and (Test-Name $p ($rs.Fields.Item('System.ItemType').Value -eq 'Directory'))) { [void]$hits.Add($p) }
    $rs.MoveNext()
  }
  $rs.Close(); $conn.Close()
} catch {
  # No index: walk the usual folders instead, slower and capped.
  $how = 'walk'
  $prune = 'node_modules','.git','appdata','$recycle.bin','.venv','venv','__pycache__','.cache','site-packages'
  $roots = @($f.desktop,$f.documents,$f.downloads,$f.pictures,$f.videos,$f.music,$f.onedrive) | ? { $_ -and (Test-Path $_) } | Select-Object -Unique
  $stack = New-Object System.Collections.Stack
  foreach ($r in $roots) { $stack.Push(@($r,0)) }
  $seen = 0
  while ($stack.Count -and $seen -lt 40000) {
    $d, $depth = $stack.Pop()
    try { $items = [IO.Directory]::GetFileSystemEntries($d) } catch { continue }
    foreach ($i in $items) {
      $seen++
      $isDir = [IO.Directory]::Exists($i)
      if (Test-Name $i $isDir) { [void]$hits.Add($i) }
      if ($isDir -and $depth -lt 6 -and $prune -notcontains [IO.Path]::GetFileName($i).ToLower()) { $stack.Push(@($i,($depth+1))) }
    }
  }
}
$res = $hits | Select-Object -Unique | % { Get-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue } | ? { $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First ([int]$env:JP_LIMIT) | % {
  @{ name=$_.Name; path=$_.FullName; folder=$(if ($_.PSIsContainer) { $true } else { $false }); modified=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'); sizeKB=$(if ($_.PSIsContainer) { $null } else { [math]::Round($_.Length/1KB) }) } }
@{ count=$hits.Count; searched=$how; results=@($res) } | ConvertTo-Json -Compress -Depth 3`,
          { QUERY: query, LIMIT: limit ?? 10 },
          30000,
        )
        return ok(out)
      }),
    ),

    tool(
      'pc_open_path',
      'Open a folder in File Explorer, or a document/picture/video with its normal app. Takes a full path (from pc_find_files) or a folder name like "downloads", "desktop", "documents\\projects". Will not run programs or scripts — use pc_open_app for apps.',
      { path: z.string().min(1).max(500) },
      guard(async ({ path: p }) => {
        if (RISKY_EXT.test(p.trim())) return fail('That is a program or script, which this will not run. Use pc_open_app for apps.')
        const out = await ps(
          FOLDERS +
            `
$p = Resolve-Spoken $env:JP_PATH
if (-not (Test-Path -LiteralPath $p)) { throw "Not found: $p" }
$item = Get-Item -LiteralPath $p -Force
if (-not $item.PSIsContainer -and $item.Extension -match '^\\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|hta|cpl|reg|jar|lnk|url)$') { throw 'That is a program or script; not opening it.' }
Invoke-Item -LiteralPath $item.FullName
$item.FullName`,
          { PATH: p },
        )
        return ok(`Opened ${out}`)
      }),
    ),

    tool(
      'pc_make_folder',
      'Create a new folder inside the user\'s own files. "where" is a folder name like "desktop", "documents", "downloads" (optionally with a subfolder, "documents\\projects") or a full path inside their user folder.',
      { where: z.string().min(1).max(300), name: z.string().min(1).max(120) },
      guard(async ({ where, name }) => {
        if (/[<>:"/\\|?*]/.test(name) || /^\.+$/.test(name.trim())) return fail('That is not a valid folder name.')
        const out = await ps(
          FOLDERS +
            `
$parent = Resolve-Spoken $env:JP_WHERE
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "No such folder: $parent" }
$target = Join-Path $parent $env:JP_NAME.Trim()
if (-not (Inside-Profile $target)) { throw 'Only inside your own user folder.' }
if (Test-Path -LiteralPath $target) { "exists: $target" } else { (New-Item -ItemType Directory -Path $target).FullName }`,
          { WHERE: where, NAME: name },
        )
        return ok(out.startsWith('exists:') ? `Already there: ${out.slice(8)}` : `Created ${out}`)
      }),
    ),

    tool(
      'pc_recycle',
      'Move a file or folder from the user\'s own files to the Recycle Bin (it can be restored from there). NEEDS THE USER\'S SPOKEN YES: the first call returns a code and a question to ask them.',
      {
        path: z.string().min(1).max(500).describe('Full path, e.g. from pc_find_files.'),
        confirm: z.string().optional().describe('The code from the first call, only after the user said yes.'),
      },
      guard(async (args) => {
        const check = await ps(
          FOLDERS +
            `
$p = [IO.Path]::GetFullPath((Resolve-Spoken $env:JP_PATH))
if (-not (Test-Path -LiteralPath $p)) { throw "Not found: $p" }
if (-not (Inside-Profile $p)) { throw 'Only files inside your own user folder.' }
if (@($f.Values | % { [IO.Path]::GetFullPath($_).TrimEnd('\\') }) -contains $p.TrimEnd('\\')) { throw 'Not a whole top-level folder like Desktop or Documents.' }
$p`,
          { PATH: args.path },
        )
        const gate = confirmGate('recycle', { path: check, confirm: args.confirm },`Shall I move ${path.basename(check)} to the Recycle Bin?`)
        if (gate) return gate
        await ps(
          `
Add-Type -AssemblyName Microsoft.VisualBasic
$p = $env:JP_PATH
if ([IO.Directory]::Exists($p)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') }
else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }`,
          { PATH: check },
        )
        return ok(`Moved ${check} to the Recycle Bin.`)
      }),
    ),

    tool(
      'pc_power',
      'Shut down, restart, sleep or sign out of this PC, optionally after some minutes; or cancel a pending shutdown/restart. Everything except cancel NEEDS THE USER\'S SPOKEN YES: the first call returns a code and a question to ask them.',
      {
        action: z.enum(['shutdown', 'restart', 'sleep', 'sign_out', 'cancel']),
        minutes: z.number().min(0).max(1440).optional().describe('Delay for shutdown/restart. Default: in 30 seconds.'),
        confirm: z.string().optional().describe('The code from the first call, only after the user said yes.'),
      },
      guard(async (args) => {
        const { action, minutes } = args
        if (action === 'cancel') {
          await ps(`shutdown.exe /a 2>$null; if ($LASTEXITCODE -ne 0) { 'none' } else { 'ok' }`).catch(() => '')
          return ok('Cancelled any pending shutdown or restart.')
        }
        const when = minutes ? `in ${minutes} minute${minutes === 1 ? '' : 's'}` : 'now'
        const words = { shutdown: 'shut down', restart: 'restart', sleep: 'put to sleep', sign_out: 'sign out of' }[action]
        const gate = confirmGate('power', args, `Shall I ${words} the computer ${action === 'sleep' || action === 'sign_out' ? 'now' : when}? Unsaved work will be lost.`)
        if (gate) return gate
        const secs = String(Math.max(30, Math.round((minutes ?? 0) * 60)))
        if (action === 'shutdown') await ps(`shutdown.exe /s /t $env:JP_T`, { T: secs })
        if (action === 'restart') await ps(`shutdown.exe /r /t $env:JP_T`, { T: secs })
        if (action === 'sign_out') await ps(`shutdown.exe /l`)
        if (action === 'sleep') {
          // A moment's delay so JARVIS can finish saying it first.
          setTimeout(() => void ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false) | Out-Null`).catch(() => {}), 4000)
          return ok('Going to sleep in a few seconds.')
        }
        return ok(
          action === 'sign_out'
            ? 'Signing out.'
            : `Scheduled ${action} in ${minutes ? `${minutes} minute(s)` : '30 seconds'}. They can say "cancel the shutdown" to stop it.`,
        )
      }),
    ),
  ]

  return tools
}

export const PROMPT_PC = `Their PC — the \`pc_*\` tools act on the Windows laptop you run on:
- Apps: \`pc_open_app\` / \`pc_close_app\` by the name they say. Websites are still the chrome tools.
- Sound and music: \`pc_volume\`, \`pc_media\` (play/pause, next, previous). Screen: \`pc_brightness\`, \`pc_screenshot\`, \`pc_lock\`.
- "Battery", "how's my laptop": \`pc_status\`. Files: \`pc_find_files\` then \`pc_open_path\`; \`pc_make_folder\`.
- \`pc_recycle\` and \`pc_power\` refuse until the user says yes. When one hands you a question, ASK it in one short sentence and stop. Only after they answer yes, call again with the code. Never answer for them, never call again in the same turn.
- Do it, then confirm in a few words ("Done, sir. Volume at forty."). Never read out a full file path — say the file name and folder.

`
