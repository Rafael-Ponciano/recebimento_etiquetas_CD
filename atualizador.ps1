# Atualizador seguro — Conferência CD
# Troca arquivos sem sobrescrever config.ini / dados locais.
# Mostra janela de progresso e desbloqueia Mark of the Web.

param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [Parameter(Mandatory = $true)][string]$StagingDir,
    [Parameter(Mandatory = $true)][string]$ExeName,
    [Parameter(Mandatory = $true)][int]$PidToWait
)

$ErrorActionPreference = "Stop"
$LogFile = Join-Path $AppDir "_update\atualizador.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null

function Write-Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Write-StatusFile([string]$msg, [int]$pct) {
    try {
        $statusPath = Join-Path $AppDir "_update\STATUS.txt"
        Set-Content -LiteralPath $statusPath -Value ("{0}`r`n{1}%" -f $msg, $pct) -Encoding UTF8
    } catch {}
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$form = New-Object System.Windows.Forms.Form
$form.Text = "Conferência CD — Atualizando"
$form.Size = New-Object System.Drawing.Size(460, 210)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 28)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "Aplicando atualização"
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(62, 207, 142)
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$lblTitle.Location = New-Object System.Drawing.Point(20, 18)
$lblTitle.AutoSize = $true

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "Iniciando…"
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(200, 210, 220)
$lblStatus.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$lblStatus.Location = New-Object System.Drawing.Point(20, 55)
$lblStatus.Size = New-Object System.Drawing.Size(400, 40)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(20, 105)
$bar.Size = New-Object System.Drawing.Size(400, 22)
$bar.Minimum = 0
$bar.Maximum = 100
$bar.Value = 5
$bar.Style = "Continuous"

$lblPct = New-Object System.Windows.Forms.Label
$lblPct.Text = "5%"
$lblPct.ForeColor = [System.Drawing.Color]::FromArgb(62, 207, 142)
$lblPct.Font = New-Object System.Drawing.Font("Consolas", 9)
$lblPct.Location = New-Object System.Drawing.Point(20, 135)
$lblPct.AutoSize = $true

$form.Controls.AddRange(@($lblTitle, $lblStatus, $bar, $lblPct))
$form.TopMost = $true
$form.Show()
$form.Activate()
$form.Refresh()
[System.Windows.Forms.Application]::DoEvents()
Write-Log "UI do atualizador aberta"
Write-StatusFile "Iniciando…" 5

function Set-Ui([string]$msg, [int]$pct) {
    if ($pct -lt 0) { $pct = 0 }
    if ($pct -gt 100) { $pct = 100 }
    $script:lblStatus.Text = $msg
    $script:bar.Value = $pct
    $script:lblPct.Text = ("{0}%" -f $pct)
    try {
        $script:form.Activate()
        $script:form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
    } catch {}
    Write-Log $msg
    Write-StatusFile $msg $pct
}

function Show-Error([string]$msg) {
    Write-Log "ERRO: $msg"
    try {
        [System.Windows.Forms.MessageBox]::Show(
            $msg,
            "Conferência CD — Atualização",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch {}
}

function Unblock-Tree([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
        $ads = $_.FullName + ":Zone.Identifier"
        try {
            if (Test-Path -LiteralPath $ads) {
                Remove-Item -LiteralPath $ads -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}

try {
    Set-Ui "Aguardando o app fechar…" 8

    if (-not (Test-Path -LiteralPath $StagingDir)) {
        throw "Pasta staging não encontrada: $StagingDir"
    }

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process -Id $PidToWait -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        Set-Ui "Aguardando o app fechar…" 12
        Start-Sleep -Milliseconds 400
    }
    Start-Sleep -Seconds 1

    Set-Ui "Encerrando processos restantes…" 18
    $exeBase = [System.IO.Path]::GetFileNameWithoutExtension($ExeName)
    $updatePrefix = (Join-Path $AppDir "_update")
    Get-Process -Name $exeBase -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and
            ($_.Path -like (Join-Path $AppDir "*")) -and
            -not ($_.Path -like (Join-Path $updatePrefix "*"))
        } |
        ForEach-Object {
            try { $_.CloseMainWindow() | Out-Null } catch {}
        }
    Start-Sleep -Seconds 1
    Get-Process -Name $exeBase -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and
            ($_.Path -like (Join-Path $AppDir "*")) -and
            -not ($_.Path -like (Join-Path $updatePrefix "*"))
        } |
        ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    Start-Sleep -Seconds 1.5

    $backupDir = Join-Path $AppDir "_update\backup_prev"
    if (Test-Path -LiteralPath $backupDir) {
        Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

    $preserveNames = @(
        "config.ini",
        "credenciais.json",
        "anymarket_token.json",
        "token_any.json",
        "conferencia_erro.log",
        "recebimento-sa-key.json"
    )
    $preserveDirs = @("downloads", "_update", "logs", "tools")

    Set-Ui "Criando backup de segurança…" 28
    Get-ChildItem -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($preserveDirs -contains $_.Name) { return }
        if ($preserveNames -contains $_.Name) { return }
        try {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $backupDir $_.Name) -Recurse -Force -ErrorAction SilentlyContinue
        } catch {}
    }

    Set-Ui "Copiando arquivos novos…" 45
    try {
        $items = @(Get-ChildItem -LiteralPath $StagingDir -Force)
        $i = 0
        foreach ($item in $items) {
            $i++
            $name = $item.Name
            if ($preserveDirs -contains $name) { continue }
            if ($preserveNames -contains $name) { continue }

            $dest = Join-Path $AppDir $name

            if ($name -eq "config" -and $item.PSIsContainer) {
                New-Item -ItemType Directory -Force -Path $dest | Out-Null
                Get-ChildItem -LiteralPath $item.FullName -Force | ForEach-Object {
                    $alvo = Join-Path $dest $_.Name
                    if ($_.Name -eq "config.ini" -and (Test-Path -LiteralPath $alvo)) { return }
                    Copy-Item -LiteralPath $_.FullName -Destination $alvo -Recurse -Force -ErrorAction SilentlyContinue
                }
                $pct = 45 + [int](($i / [Math]::Max(1, $items.Count)) * 35)
                Set-Ui ("Copiando: {0}" -f $name) $pct
                continue
            }
            if ($name -eq "dados" -and $item.PSIsContainer) {
                New-Item -ItemType Directory -Force -Path $dest | Out-Null
                Get-ChildItem -LiteralPath $item.FullName -Force -File | ForEach-Object {
                    $alvo = Join-Path $dest $_.Name
                    if (Test-Path -LiteralPath $alvo) { return }
                    Copy-Item -LiteralPath $_.FullName -Destination $alvo -Force -ErrorAction SilentlyContinue
                }
                $pct = 45 + [int](($i / [Math]::Max(1, $items.Count)) * 35)
                Set-Ui ("Copiando: {0}" -f $name) $pct
                continue
            }

            if (Test-Path -LiteralPath $dest) {
                $aside = Join-Path $AppDir ("{0}.__old_{1}" -f $name, [Environment]::TickCount)
                $moved = $false
                for ($t = 0; $t -lt 8; $t++) {
                    try {
                        Move-Item -LiteralPath $dest -Destination $aside -Force -ErrorAction Stop
                        $moved = $true
                        break
                    } catch {
                        Start-Sleep -Milliseconds (250 + ($t * 100))
                    }
                }
                if ($moved) {
                    Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue
                } else {
                    $ok = $false
                    for ($t = 0; $t -lt 12; $t++) {
                        try {
                            Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Stop
                            $ok = $true
                            break
                        } catch {
                            Start-Sleep -Milliseconds (350 + ($t * 150))
                        }
                    }
                    if (-not $ok) {
                        throw "Acesso negado ao substituir: $dest"
                    }
                }
            }
            Copy-Item -LiteralPath $item.FullName -Destination $dest -Recurse -Force -ErrorAction Stop
            $pct = 45 + [int](($i / [Math]::Max(1, $items.Count)) * 35)
            Set-Ui ("Copiando: {0}" -f $name) $pct
        }
    } catch {
        Set-Ui "Falha na cópia — restaurando backup…" 50
        Get-ChildItem -LiteralPath $backupDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
            $dest = Join-Path $AppDir $_.Name
            try {
                if (Test-Path -LiteralPath $dest) {
                    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
                }
                Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force -ErrorAction SilentlyContinue
            } catch {}
        }
        throw "Falha ao aplicar update: $($_.Exception.Message). Tentativa de restaurar a versão anterior."
    }

    Set-Ui "Atualizando config.ini…" 84
    try {
        # Migra layout legado (raiz → pastas) e remove duplicatas na raiz
        $configDir = Join-Path $AppDir "config"
        $dadosDir = Join-Path $AppDir "dados"
        $toolsDir = Join-Path $AppDir "tools"
        $staticDir = Join-Path $AppDir "static"
        $logsDir = Join-Path $AppDir "logs"
        New-Item -ItemType Directory -Force -Path $configDir | Out-Null
        New-Item -ItemType Directory -Force -Path $dadosDir | Out-Null
        function Move-Or-Clean([string]$src, [string]$dst) {
            if (-not (Test-Path -LiteralPath $src)) { return }
            $parent = Split-Path -Parent $dst
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            if (-not (Test-Path -LiteralPath $dst)) {
                Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction SilentlyContinue
            } elseif (Test-Path -LiteralPath $src) {
                Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($nome in @("config.ini", "config.example.ini")) {
            Move-Or-Clean (Join-Path $AppDir $nome) (Join-Path $configDir $nome)
        }
        foreach ($nome in @("recebimento-sa-key.json", "credenciais.json", "token_any.json", "anymarket_token.json")) {
            Move-Or-Clean (Join-Path $AppDir $nome) (Join-Path $dadosDir $nome)
        }
        Move-Or-Clean (Join-Path $AppDir "atualizador.ps1") (Join-Path $toolsDir "atualizador.ps1")
        Move-Or-Clean (Join-Path $AppDir "delivery.ico") (Join-Path $staticDir "delivery.ico")
        Move-Or-Clean (Join-Path $AppDir "conferencia_erro.log") (Join-Path $logsDir "conferencia_erro.log")
        Move-Or-Clean (Join-Path $AppDir "_ui_cache_version.txt") (Join-Path $AppDir "_webview_data\_ui_cache_version.txt")

        $userIni = Join-Path $configDir "config.ini"
        if (-not (Test-Path -LiteralPath $userIni)) { $userIni = Join-Path $AppDir "config.ini" }
        $exampleIni = Join-Path $configDir "config.example.ini"
        if (-not (Test-Path -LiteralPath $exampleIni)) { $exampleIni = Join-Path $AppDir "config.example.ini" }
        $forceKeys = @(
            "SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_TABELA_PEDIDOS",
            "BQ_PROJECT", "BQ_TABELA_PEDIDOS", "BQ_CREDENTIALS_FILE",
            "UPDATE_BUCKET", "UPDATE_LATEST_PATH", "UPDATE_LATEST_URL", "UPDATE_ENABLED"
        )
        if ((Test-Path -LiteralPath $userIni) -and (Test-Path -LiteralPath $exampleIni)) {
            $userLines = @(Get-Content -LiteralPath $userIni -Encoding UTF8)
            $exampleLines = @(Get-Content -LiteralPath $exampleIni -Encoding UTF8)
            $exampleMap = @{}
            foreach ($line in $exampleLines) {
                if ($line -match '^\s*;' -or $line -match '^\s*$' -or $line -match '^\s*\[') { continue }
                if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') {
                    $exampleMap[$Matches[1].ToUpper()] = @{ Key = $Matches[1]; Value = $Matches[2].TrimEnd(); Raw = $line.TrimEnd() }
                }
            }
            $changed = @()
            $seen = @{}
            $out = New-Object System.Collections.Generic.List[string]
            foreach ($line in $userLines) {
                if ($line -match '^\s*([A-Za-z0-9_]+)\s*=') {
                    $key = $Matches[1]
                    $keyUp = $key.ToUpper()
                    $seen[$keyUp] = $true
                    if ($forceKeys -contains $keyUp -and $exampleMap.ContainsKey($keyUp)) {
                        $ex = $exampleMap[$keyUp]
                        $out.Add(("{0} = {1}" -f $ex.Key, $ex.Value)) | Out-Null
                        $changed += $keyUp
                        continue
                    }
                }
                $out.Add($line) | Out-Null
            }
            foreach ($kv in $exampleMap.GetEnumerator()) {
                if (-not $seen.ContainsKey($kv.Key)) {
                    $out.Add($kv.Value.Raw) | Out-Null
                    $changed += $kv.Key
                }
            }
            if ($changed.Count -gt 0) {
                Set-Content -LiteralPath $userIni -Value ($out -join "`r`n") -Encoding UTF8
                Write-Log ("config.ini sync: " + (($changed | Select-Object -Unique) -join ", "))
            }
        }
        $keyDest = Join-Path $dadosDir "recebimento-sa-key.json"
        $keySrc = Join-Path $StagingDir "dados\recebimento-sa-key.json"
        if (-not (Test-Path -LiteralPath $keySrc)) {
            $keySrc = Join-Path $StagingDir "recebimento-sa-key.json"
        }
        if (-not (Test-Path -LiteralPath $keyDest) -and (Test-Path -LiteralPath $keySrc)) {
            Copy-Item -LiteralPath $keySrc -Destination $keyDest -Force
            Write-Log "dados/recebimento-sa-key.json instalada"
        }
    } catch {
        Write-Log ("Aviso merge config: " + $_.Exception.Message)
    }

    Set-Ui "Desbloqueando arquivos (Windows)…" 88
    Unblock-Tree $AppDir

    $exePath = Join-Path $AppDir $ExeName
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "Executável não encontrado após update: $exePath"
    }

    Set-Ui "Limpando arquivos temporários…" 94
    $stagingParent = Join-Path $AppDir "_update\staging"
    $payload = Join-Path $AppDir "_update\payload"
    $zip = Join-Path $AppDir "_update\package.zip"
    Remove-Item -LiteralPath $stagingParent -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $payload -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

    Set-Ui "Concluído! Reabrindo o app…" 100
    Start-Sleep -Milliseconds 700
    Start-Process -FilePath $exePath -WorkingDirectory $AppDir
    $form.Close()
    exit 0
}
catch {
    $err = $_.Exception.Message
    try { $form.Close() } catch {}
    Show-Error @"
Falha ao atualizar o Conferência CD.

$err

O app anterior não foi apagado. Tente abrir novamente o executável.
Detalhes: $LogFile
"@
    try {
        $exePath = Join-Path $AppDir $ExeName
        if (Test-Path -LiteralPath $exePath) {
            Start-Process -FilePath $exePath -WorkingDirectory $AppDir
        }
    } catch {}
    exit 1
}
