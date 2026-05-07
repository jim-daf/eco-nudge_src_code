#!/usr/bin/env bash
# =============================================================================
# Deploy Eco-Nudge + Eye-Tracking Data Server to Azure App Service
#
# This creates a single Azure App Service (Node.js) that serves:
#   - The frontend (index.html, app.js, etc.)
#   - The eye-tracking data API (/api/sessions/...)
#
# Prerequisites:
#   - Azure CLI installed: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
#   - Logged in: az login
#
# Usage:
#   chmod +x deploy/deploy-app-service.sh
#   ./deploy/deploy-app-service.sh
#
# Or with custom options:
#   ./deploy/deploy-app-service.sh --name my-eco-nudge --location eastus
# =============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
APP_NAME="eco-nudge-et-$(openssl rand -hex 4)"
RESOURCE_GROUP="eco-nudge-rg"
LOCATION="eastus"
SKU="B1"           # Basic tier — cheapest for always-on ($13/mo). Use F1 for free tier.
NODE_VERSION="20-lts"

# ── Parse Arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --name)       APP_NAME="$2";        shift 2;;
        --rg)         RESOURCE_GROUP="$2";   shift 2;;
        --location)   LOCATION="$2";        shift 2;;
        --sku)        SKU="$2";             shift 2;;
        *)            echo "Unknown: $1";    exit 1;;
    esac
done

echo "══════════════════════════════════════════════════════"
echo "  Eco-Nudge — Azure App Service Deployment"
echo "  App Name : $APP_NAME"
echo "  Resource : $RESOURCE_GROUP"
echo "  Location : $LOCATION"
echo "  SKU      : $SKU"
echo "══════════════════════════════════════════════════════"
echo ""

# ── 1. Resource Group ────────────────────────────────────────────────────────
echo "[1/5] Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

# ── 2. App Service Plan ─────────────────────────────────────────────────────
PLAN_NAME="${APP_NAME}-plan"
echo "[2/5] Creating App Service plan ($SKU)..."
az appservice plan create \
    --name "$PLAN_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku "$SKU" \
    --is-linux \
    --output none

# ── 3. Create Web App ───────────────────────────────────────────────────────
echo "[3/5] Creating web app..."
az webapp create \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --plan "$PLAN_NAME" \
    --runtime "NODE:$NODE_VERSION" \
    --output none

# Configure startup command
az webapp config set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --startup-file "node server/server.js" \
    --output none

# Enable persistent storage for uploads
az webapp config appsettings set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --settings WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
    --output none

# ── 4. Deploy Code ──────────────────────────────────────────────────────────
echo "[4/5] Deploying application code..."

# Create a temporary deployment package (exclude files not needed on server)
DEPLOY_DIR=$(mktemp -d)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Copy project files
rsync -a --exclude='.git' \
         --exclude='.venv' \
         --exclude='output-sketch' \
         --exclude='demo' \
         --exclude='*.pptx' \
         --exclude='*.docx' \
         --exclude='*.zip' \
         --exclude='*.png' \
         --exclude='*.py' \
         --exclude='deploy.zip' \
         --exclude='server/uploads' \
         --exclude='server/node_modules' \
         "$PROJECT_DIR/" "$DEPLOY_DIR/"

# Create root package.json for Azure (points to server)
cat > "$DEPLOY_DIR/package.json" <<'EOF'
{
  "name": "eco-nudge-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node server/server.js",
    "install": "cd server && npm install --production"
  }
}
EOF

cd "$DEPLOY_DIR"
zip -r /tmp/eco-nudge-deploy.zip . -x "*.git*" > /dev/null

az webapp deployment source config-zip \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --src /tmp/eco-nudge-deploy.zip \
    --output none

rm -rf "$DEPLOY_DIR" /tmp/eco-nudge-deploy.zip

# ── 5. Done ─────────────────────────────────────────────────────────────────
APP_URL="https://${APP_NAME}.azurewebsites.net"
echo ""
echo "[5/5] Deployment complete!"
echo ""
echo "══════════════════════════════════════════════════════"
echo "  App URL     : $APP_URL"
echo "  API Base    : $APP_URL/api/sessions"
echo "  Resource Grp: $RESOURCE_GROUP"
echo "══════════════════════════════════════════════════════"
echo ""
echo "Uploaded data will be stored at: /home/site/wwwroot/server/uploads/"
echo ""
echo "To view logs:  az webapp log tail --name $APP_NAME --resource-group $RESOURCE_GROUP"
echo "To redeploy:   re-run this script with --name $APP_NAME"
echo "To delete:     az group delete --name $RESOURCE_GROUP --yes"
