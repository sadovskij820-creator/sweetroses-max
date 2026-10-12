# Sweet Roses — бесплатный запуск демо на этом компьютере.
# Приложение работает, пока открыто это окно. Закройте окно, чтобы остановить.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'Sweet Roses — демо (не закрывайте)'
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'tools') | Out-Null
try { Start-Transcript -Path (Join-Path $PSScriptRoot 'tools\launch.log') -Force | Out-Null } catch {}

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }
function Fail($text) { Say ""; Say $text 'Red'; Say ""; Read-Host 'Нажмите Enter, чтобы закрыть'; exit 1 }

Say ''
Say '  Sweet Roses — мини-апп для Telegram (демо)' 'Yellow'
Say ''

# 0. Если демо уже запущено (старое окно) — останавливаем его копию, чтобы освободить порт 3000
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*server/index.js*' -or $_.CommandLine -like '*server\index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say 'Остановил предыдущий запуск демо.' 'Gray' }
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*localhost:3000*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
Start-Sleep -Milliseconds 800

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say '[1/4] Node.js не найден — устанавливаю (это бесплатно, 1–2 минуты)...' 'Cyan'
  try { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Host } catch {}
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Start-Process 'https://nodejs.org/ru/download'
    Fail 'Не получилось установить Node.js автоматически. Скачайте LTS-версию с открывшегося сайта, установите и запустите этот файл снова.'
  }
}
Say ('[1/4] Node.js ' + (node -v)) 'Green'

# 2. Токен бота
$envFile = Join-Path $PSScriptRoot '.env'
$hasToken = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^BOT_TOKEN=\d+:[\w-]{30,}' -Quiet)
if (-not $hasToken) {
  Say ''
  Say 'Вставьте токен бота от @BotFather (строка вида 123456789:AA...).' 'Yellow'
  Say 'Чтобы вставить: щёлкните правой кнопкой мыши в этом окне, затем нажмите Enter.' 'Gray'
  $token = (Read-Host 'Токен').Trim()
  if ($token -notmatch '^\d+:[\w-]{30,}$') { Fail 'Это не похоже на токен. Скопируйте его целиком из сообщения BotFather и запустите файл снова.' }
  [System.IO.File]::WriteAllText($envFile, "BOT_TOKEN=$token`nPORT=3000`n", (New-Object System.Text.UTF8Encoding($false)))
}
Say '[2/4] Токен бота найден' 'Green'

# 3. Туннель Cloudflare (бесплатный HTTPS-адрес без регистрации)
$tools = Join-Path $PSScriptRoot 'tools'
$cf = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $cf)) {
  Say '[3/4] Скачиваю cloudflared с официального GitHub Cloudflare (~60 МБ, один раз)...' 'Cyan'
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing }
  catch { Fail 'Не удалось скачать cloudflared. Проверьте интернет и запустите файл снова.' }
}
$log = Join-Path $tools 'tunnel.log'
Remove-Item $log -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cf -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://localhost:3000' -RedirectStandardError $log -WindowStyle Hidden -PassThru
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue; Fail 'Туннель не запустился за минуту. Попробуйте ещё раз; если не поможет — проверьте, не блокирует ли антивирус файл tools\cloudflared.exe.' }
Say "[3/4] Адрес приложения: $url" 'Green'

# 3b. Прокси/VPN: Node.js сам не использует системный прокси Windows (например, Hiddify) — передаём его явно
$inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
if ($inet -and $inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
  $proxy = [string]$inet.ProxyServer
  if ($proxy -match 'https=([^;]+)') { $proxy = $Matches[1] } elseif ($proxy -match 'http=([^;]+)') { $proxy = $Matches[1] } elseif ($proxy -match 'socks=') { $proxy = $null }
  if ($proxy) {
    if ($proxy -notmatch '://') { $proxy = "http://$proxy" }
    $env:HTTPS_PROXY = $proxy; $env:HTTP_PROXY = $proxy; $env:NO_PROXY = 'localhost,127.0.0.1'; $env:NODE_USE_ENV_PROXY = '1'
    Say "      Системный прокси: $proxy" 'Gray'
  }
}
$tgOk = $false
try { Invoke-WebRequest 'https://api.telegram.org' -UseBasicParsing -TimeoutSec 10 | Out-Null; $tgOk = $true } catch { if ($_.Exception.Response) { $tgOk = $true } }
if (-not $tgOk) {
  Say ''
  Say 'ВНИМАНИЕ: с этого компьютера не открывается api.telegram.org — бот не сможет отвечать.' 'Red'
  Say 'Включите VPN (например, Hiddify) в режиме «Системный прокси» или «VPN», затем закройте это окно и запустите файл снова.' 'Red'
  Say ''
}

# 4. Приложение и бот
Say '[4/4] Запускаю приложение и бота...' 'Cyan'
Say ''
Say '  Готово! Откройте своего бота в Telegram и отправьте /start.' 'Yellow'
Say '  Кто первым отправит /start, станет администратором (шестерёнка в приложении).' 'Yellow'
Say '  Не закрывайте это окно, пока показываете приложение.' 'Yellow'
Say ''
$env:WEBAPP_URL = $url
$ErrorActionPreference = 'Continue'  # stderr сервера не должен останавливать скрипт
try {
  while ($true) {
    node server/index.js 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath (Join-Path $tools 'server.log') -Append
    Say 'Приложение остановилось — перезапускаю через 3 секунды (окно не закрывайте)...' 'Yellow'
    Start-Sleep -Seconds 3
  }
}
finally { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
Read-Host 'Приложение остановлено. Нажмите Enter, чтобы закрыть'
