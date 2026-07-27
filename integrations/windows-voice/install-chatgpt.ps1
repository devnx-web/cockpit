param(
    [switch]$EnableMicrophone
)

$ErrorActionPreference = "Stop"

if ($EnableMicrophone) {
    $Log = "C:\ailiv-microphone-result.txt"
    Start-Transcript -Path $Log -Force

    try {
        Write-Host "Liberando o microfone para o Ailiv Voice..." -ForegroundColor Cyan

        $PolicyKey = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy"
        New-Item -Path $PolicyKey -Force | Out-Null
        New-ItemProperty `
            -Path $PolicyKey `
            -Name "LetAppsAccessMicrophone" `
            -PropertyType DWord `
            -Value 1 `
            -Force | Out-Null

        $MachineConsent = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        $UserConsent = "HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        foreach ($ConsentKey in @($MachineConsent, $UserConsent)) {
            New-Item -Path $ConsentKey -Force | Out-Null
            New-ItemProperty -Path $ConsentKey -Name "Value" -Value "Allow" -Force | Out-Null
        }

        $Installed = Get-AppxPackage -Name "OpenAI.Codex"
        if (-not $Installed) {
            throw "O aplicativo Ailiv Voice não foi encontrado."
        }

        $AppConsent = Join-Path $UserConsent $Installed.PackageFamilyName
        New-Item -Path $AppConsent -Force | Out-Null
        New-ItemProperty -Path $AppConsent -Name "Value" -Value "Allow" -Force | Out-Null

        & gpupdate.exe /target:computer /force

        $PolicyValue = Get-ItemPropertyValue `
            -Path $PolicyKey `
            -Name "LetAppsAccessMicrophone"
        $AppValue = Get-ItemPropertyValue -Path $AppConsent -Name "Value"

        Write-Host "Política de microfone: $PolicyValue" -ForegroundColor Green
        Write-Host "Aplicativo: $($Installed.PackageFamilyName)" -ForegroundColor Green
        Write-Host "Consentimento: $AppValue" -ForegroundColor Green
        Write-Host "Reiniciando o Windows para aplicar..." -ForegroundColor Yellow
    } finally {
        Stop-Transcript
    }

    shutdown.exe /r /t 10
    exit
}

$Package = Join-Path $PSScriptRoot "ChatGPT-x64.msix"
if (-not (Test-Path $Package)) {
    $Package = Join-Path $env:TEMP "ChatGPT-x64.msix"
    Write-Host "Recebendo o pacote oficial do host Linux..." -ForegroundColor Cyan
    Invoke-WebRequest `
        -Uri "http://10.0.2.2:18080/ChatGPT-x64.msix" `
        -OutFile $Package `
        -UseBasicParsing
}

Write-Host "Verificando a assinatura do pacote oficial..." -ForegroundColor Cyan
$Signature = Get-AuthenticodeSignature -FilePath $Package
if ($Signature.Status -ne "Valid") {
    throw "Assinatura inválida ou não verificável: $($Signature.Status)"
}

$Existing = Get-AppxPackage -Name "OpenAI.Codex"
if ($Existing) {
    Write-Host "Atualizando OpenAI.Codex $($Existing.Version)..." -ForegroundColor Yellow
} else {
    Write-Host "Instalando o aplicativo ChatGPT/Codex..." -ForegroundColor Cyan
}

Add-AppxPackage -Path $Package -ForceApplicationShutdown
$Installed = Get-AppxPackage -Name "OpenAI.Codex"
if (-not $Installed) {
    throw "O Windows não registrou o pacote OpenAI.Codex."
}

$MicrophoneConsent = "HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
New-Item -Path $MicrophoneConsent -Force | Out-Null
Set-ItemProperty -Path $MicrophoneConsent -Name "Value" -Value "Allow"

Write-Host "Instalação concluída: $($Installed.Name) $($Installed.Version)" -ForegroundColor Green
Write-Host "Abrindo o aplicativo para login..." -ForegroundColor Green
$AppUserModelId = "$($Installed.PackageFamilyName)!App"
Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\$AppUserModelId"
