<#
.SYNOPSIS
    Deploy Eco-Nudge + Eye-Tracking Data Server to Azure App Service

.DESCRIPTION
    Creates a single Azure App Service (Node.js) that serves:
      - The frontend (index.html, app.js, etc.)
      - The eye-tracking data API (/api/sessions/...)

.PREREQUISITES
    - Azure CLI installed: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
    - Logged in: az login

.USAGE
    .\deploy\deploy-app-service.ps1
    .\deploy\deploy-app-service.ps1 -AppName "my-eco-nudge" -Location "eastus"
#>

param(
    [string]$AppName = "eco-nudge-et-$(Get-Random -Maximum 9999)",
    [string]$ResourceGroup = "eco-nudge-rg",
    [string]$Location = "eastus",
    [string]$Sku = "B1"          # B1 = Basic ($13/mo). Use F1 for free tier (limited).
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Eco-Nudge - Azure App Service Deployment"
Write-Host "  App Name : $AppName"
Write-Host "  Resource : $ResourceGroup"
Write-Host "  Location : $Location"
Write-Host "  SKU      : $Sku"
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Resource Group ────────────────────────────────────────────────────────
Write-Host "[1/5] Creating resource group..." -ForegroundColor Yellow
az group create --name $ResourceGroup --location $Location --output none
if ($LASTEXITCODE -ne 0) { throw "Failed to create resource group" }

# ── 2. App Service Plan ─────────────────────────────────────────────────────
$PlanName = "$AppName-plan"
Write-Host "[2/5] Creating App Service plan ($Sku)..." -ForegroundColor Yellow
az appservice plan create `
    --name $PlanName `
    --resource-group $ResourceGroup `
    --location $Location `
    --sku $Sku `
    --is-linux `
    --output none
if ($LASTEXITCODE -ne 0) { throw "Failed to create App Service plan" }

# ── 3. Create Web App ───────────────────────────────────────────────────────
Write-Host "[3/5] Creating web app..." -ForegroundColor Yellow
az webapp create `
    --name $AppName `
    --resource-group $ResourceGroup `
    --plan $PlanName `
    --runtime "NODE:20-lts" `
    --output none
if ($LASTEXITCODE -ne 0) { throw "Failed to create web app" }

# Configure startup command
az webapp config set `
    --name $AppName `
    --resource-group $ResourceGroup `
    --startup-file "node server/server.js" `
    --output none

# Enable persistent storage
az webapp config appsettings set `
    --name $AppName `
    --resource-group $ResourceGroup `
    --settings WEBSITES_ENABLE_APP_SERVICE_STORAGE=true `
    --output none

# ── 4. Deploy Code ──────────────────────────────────────────────────────────
Write-Host "[4/5] Deploying application code..." -ForegroundColor Yellow

# Create a zip of the project for deployment
$ZipPath = Join-Path $env:TEMP "eco-nudge-deploy.zip"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

# Files/folders to include in the deployment
$includeFiles = @(
    "index.html",
    "research-methodology.html",
    "app.js",
    "config.js",
    "eco-data.js",
    "eye-tracking-research.js",
    "eye-tracking-research.css",
    "styles.css",
    "webgazer.js",
    "package.json",
    ".deployment"
)

$TempDeploy = Join-Path $env:TEMP "eco-nudge-deploy"
if (Test-Path $TempDeploy) { Remove-Item $TempDeploy -Recurse -Force }
New-Item -ItemType Directory -Path $TempDeploy | Out-Null

# Copy individual files
foreach ($file in $includeFiles) {
    $srcPath = Join-Path $ProjectDir $file
    if (Test-Path $srcPath) {
        Copy-Item $srcPath -Destination $TempDeploy
    }
}

# Copy images folder if it exists
$imagesDir = Join-Path $ProjectDir "images"
if (Test-Path $imagesDir) {
    Copy-Item $imagesDir -Destination (Join-Path $TempDeploy "images") -Recurse
}

# Copy server folder (without node_modules and uploads)
$serverSrc = Join-Path $ProjectDir "server"
$serverDest = Join-Path $TempDeploy "server"
New-Item -ItemType Directory -Path $serverDest | Out-Null
Copy-Item (Join-Path $serverSrc "server.js") -Destination $serverDest
Copy-Item (Join-Path $serverSrc "package.json") -Destination $serverDest

# Create the zip
Compress-Archive -Path "$TempDeploy\*" -DestinationPath $ZipPath -Force

# Deploy
az webapp deployment source config-zip `
    --name $AppName `
    --resource-group $ResourceGroup `
    --src $ZipPath `
    --output none
if ($LASTEXITCODE -ne 0) { throw "Deployment failed" }

# Cleanup
Remove-Item $TempDeploy -Recurse -Force
Remove-Item $ZipPath -Force

# ── 5. Done ─────────────────────────────────────────────────────────────────
$AppUrl = "https://$AppName.azurewebsites.net"

Write-Host ""
Write-Host "[5/5] Deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  App URL     : $AppUrl" -ForegroundColor Green
Write-Host "  API Base    : $AppUrl/api/sessions" -ForegroundColor Green
Write-Host "  Resource Grp: $ResourceGroup"
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Uploaded research data is stored on the App Service filesystem."
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  View logs  : az webapp log tail --name $AppName --resource-group $ResourceGroup"
Write-Host "  Redeploy   : re-run this script with -AppName $AppName"
Write-Host "  Delete all : az group delete --name $ResourceGroup --yes"
Write-Host ""
