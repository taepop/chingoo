# Script to enable Windows Long Path Support
# This requires Administrator privileges
# Run: PowerShell -ExecutionPolicy Bypass -File enable-long-paths.ps1

Write-Host "Enabling Windows Long Path Support..." -ForegroundColor Yellow
Write-Host "This requires Administrator privileges." -ForegroundColor Yellow
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator', then run this script again." -ForegroundColor Yellow
    exit 1
}

try {
    $registryPath = "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem"
    $propertyName = "LongPathsEnabled"
    
    # Check if the property already exists
    $currentValue = Get-ItemProperty -Path $registryPath -Name $propertyName -ErrorAction SilentlyContinue
    
    if ($currentValue.LongPathsEnabled -eq 1) {
        Write-Host "Long Path Support is already enabled!" -ForegroundColor Green
    } else {
        # Set the registry value
        New-ItemProperty -Path $registryPath -Name $propertyName -Value 1 -PropertyType DWORD -Force | Out-Null
        Write-Host "Long Path Support has been enabled!" -ForegroundColor Green
        Write-Host ""
        Write-Host "IMPORTANT: You must restart your computer for this change to take effect." -ForegroundColor Yellow
        Write-Host "After restarting, try building again with: npx expo run:android" -ForegroundColor Yellow
    }
} catch {
    Write-Host "ERROR: Failed to enable Long Path Support: $_" -ForegroundColor Red
    exit 1
}
