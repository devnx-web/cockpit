@echo off
setlocal

set "LOG=C:\ailiv-microphone-result.txt"
(
  echo Ailiv microphone permission setup
  echo Timestamp: %DATE% %TIME%
  echo.

  echo [1/4] Forcing microphone access for packaged Windows apps...
  reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy" /v LetAppsAccessMicrophone /t REG_DWORD /d 1 /f

  echo.
  echo [2/4] Enabling the global microphone consent stores...
  reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" /v Value /t REG_SZ /d Allow /f
  reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" /v Value /t REG_SZ /d Allow /f

  echo.
  echo [3/4] Enabling microphone access for the installed Ailiv voice application...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$package = Get-AppxPackage OpenAI.Codex; if (-not $package) { throw 'OpenAI.Codex package was not found.' }; $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\' + $package.PackageFamilyName; New-Item -Path $key -Force | Out-Null; Set-ItemProperty -Path $key -Name Value -Value Allow; Write-Output ('PackageFamilyName=' + $package.PackageFamilyName)"

  echo.
  echo [4/4] Refreshing Windows policies and checking the result...
  gpupdate /target:computer /force
  reg query "HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy" /v LetAppsAccessMicrophone
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$package = Get-AppxPackage OpenAI.Codex; $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\' + $package.PackageFamilyName; Get-ItemProperty -Path $key -Name Value | Format-List"
) > "%LOG%" 2>&1

type "%LOG%"
echo.
echo The computer will restart in 10 seconds to apply the permission.
shutdown.exe /r /t 10

