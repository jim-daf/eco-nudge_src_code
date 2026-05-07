#!/usr/bin/env bash
# =============================================================================
# Eco-Nudge — Azure VM Deployment Script
#
# Creates and configures an Azure VM with Ollama for the Eco-Nudge app.
# Designed for Azure for Students ($100 credit).
#
# Prerequisites:
#   - Azure CLI installed (https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
#   - Logged in: az login
#   - Azure for Students subscription active
#
# Usage:
#   chmod +x deploy-azure.sh
#   ./deploy-azure.sh --domain ollama.yourdomain.com --email you@email.com
#
# If you don't have a custom domain, the script will use the VM's public IP
# with a free Azure DNS label: <your-label>.australiaeast.cloudapp.azure.com
# =============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
RESOURCE_GROUP="eco-nudge-rg"
LOCATION="eastus"                  # Change to your nearest region
VM_NAME="eco-nudge-vm"
VM_SIZE="Standard_B2s"             # Free tier for students (2 vCPU, 4 GB)
MODEL="qwen3:1.7b"                # Fits in 4 GB RAM; use qwen3:4b with B2ms
DOMAIN=""
EMAIL=""
DNS_LABEL="eco-nudge-$$"          # Unique DNS label fallback
API_KEY=""
IMAGE="Canonical:ubuntu-24_04-lts:server:latest"

# ── Parse Arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)     DOMAIN="$2";         shift 2;;
        --email)      EMAIL="$2";          shift 2;;
        --api-key)    API_KEY="$2";        shift 2;;
        --model)      MODEL="$2";          shift 2;;
        --location)   LOCATION="$2";       shift 2;;
        --vm-size)    VM_SIZE="$2";        shift 2;;
        --dns-label)  DNS_LABEL="$2";      shift 2;;
        *)            echo "Unknown: $1";  exit 1;;
    esac
done

if [[ -z "$EMAIL" ]]; then
    echo "Usage: $0 --email <your-email> [--domain <domain>] [--api-key <key>] [--model <model>]"
    echo ""
    echo "Options:"
    echo "  --domain     Custom domain (optional — uses Azure DNS label if omitted)"
    echo "  --email      Email for Let's Encrypt SSL"
    echo "  --api-key    API key for authentication (auto-generated if omitted)"
    echo "  --model      Ollama model to pull (default: qwen3:1.7b)"
    echo "  --location   Azure region (default: eastus)"
    echo "  --vm-size    VM size (default: Standard_B2s — free for students)"
    echo "  --dns-label  Azure DNS label (default: auto-generated)"
    exit 1
fi

# Auto-select ARM64 image for ARM-based VM sizes (B*ps*, D*ps*, E*ps* families)
if [[ "$VM_SIZE" =~ p[a-z]*_v[0-9] ]] || [[ "$VM_SIZE" =~ ps_v[0-9] ]]; then
    IMAGE="Canonical:ubuntu-24_04-lts:server-arm64:latest"
    echo "Detected ARM VM size ($VM_SIZE) — using ARM64 image"
fi

# Auto-generate API key if not provided
if [[ -z "$API_KEY" ]]; then
    API_KEY=$(openssl rand -hex 32)
    echo "Generated API key: $API_KEY"
    echo "(Save this — you'll need it for the app Settings page)"
    echo ""
fi

echo "══════════════════════════════════════════════════════"
echo "  Eco-Nudge Azure Deployment"
echo "  Region   : $LOCATION"
echo "  VM Size  : $VM_SIZE"
echo "  Model    : $MODEL"
echo "  Domain   : ${DOMAIN:-<auto: $DNS_LABEL.$LOCATION.cloudapp.azure.com>}"
echo "══════════════════════════════════════════════════════"
echo ""

# ── 1. Resource Group ────────────────────────────────────────────────────────
echo "[1/5] Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

# ── 2. Create VM ─────────────────────────────────────────────────────────────
echo "[2/5] Creating VM ($VM_SIZE)..."
az vm create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --image "$IMAGE" \
    --size "$VM_SIZE" \
    --admin-username azureuser \
    --generate-ssh-keys \
    --public-ip-sku Standard \
    --output none

# Assign DNS label to the public IP
echo "  Assigning DNS label: $DNS_LABEL..."
PUBLIC_IP_ID=$(az vm show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --query "networkProfile.networkInterfaces[0].id" -o tsv)

NIC_ID=$(az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
    --query "networkProfile.networkInterfaces[0].id" -o tsv)

IP_CONFIG=$(az network nic show --ids "$NIC_ID" \
    --query "ipConfigurations[0].publicIPAddress.id" -o tsv)

az network public-ip update --ids "$IP_CONFIG" \
    --dns-name "$DNS_LABEL" --output none

# Get the FQDN
FQDN=$(az network public-ip show --ids "$IP_CONFIG" --query "dnsSettings.fqdn" -o tsv)
PUBLIC_IP=$(az network public-ip show --ids "$IP_CONFIG" --query "ipAddress" -o tsv)

echo "  VM created: $FQDN ($PUBLIC_IP)"

# Use custom domain if provided, otherwise use Azure FQDN
EFFECTIVE_DOMAIN="${DOMAIN:-$FQDN}"

# ── 3. Open Ports ────────────────────────────────────────────────────────────
echo "[3/5] Opening ports 80 and 443..."
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
    --port 80 --priority 1010 --output none
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
    --port 443 --priority 1020 --output none

# ── 4. Prepare cloud-init script ─────────────────────────────────────────────
echo "[4/5] Preparing setup script..."

# Create a temporary script to upload and run on the VM
SETUP_SCRIPT=$(mktemp)
cat > "$SETUP_SCRIPT" <<'REMOTE_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

DOMAIN="__DOMAIN__"
EMAIL="__EMAIL__"
API_KEY="__API_KEY__"
MODEL="__MODEL__"

export DEBIAN_FRONTEND=noninteractive

echo "=== Updating system ==="
apt-get update -y && apt-get upgrade -y
apt-get install -y curl nginx certbot python3-certbot-nginx ufw git

echo "=== Configuring firewall ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "=== Installing Ollama ==="
curl -fsSL https://ollama.com/install.sh | sh

mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_ORIGINS=https://${DOMAIN}"
EOF

systemctl daemon-reload
systemctl enable ollama
systemctl restart ollama

# Wait for Ollama
for i in {1..30}; do
    curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 2
done

echo "=== Pulling model: $MODEL ==="
ollama pull "$MODEL"

echo "=== Deploying frontend ==="
WEBROOT="/var/www/eco-nudge"
mkdir -p "$WEBROOT"

# If the project was uploaded, copy files
if [[ -d /tmp/eco-nudge-src ]]; then
    cp /tmp/eco-nudge-src/index.html  "$WEBROOT/" 2>/dev/null || true
    cp /tmp/eco-nudge-src/app.js      "$WEBROOT/" 2>/dev/null || true
    cp /tmp/eco-nudge-src/eco-data.js "$WEBROOT/" 2>/dev/null || true
    cp /tmp/eco-nudge-src/styles.css  "$WEBROOT/" 2>/dev/null || true
fi
chown -R www-data:www-data "$WEBROOT"

echo "=== Configuring Nginx ==="
# Start with HTTP-only config; certbot will add SSL block automatically
cat > /etc/nginx/sites-available/eco-nudge <<NGINXEOF
limit_req_zone \$binary_remote_addr zone=ollama_limit:10m rate=10r/s;

server {
    listen 80;
    server_name ${DOMAIN};

    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    root ${WEBROOT};
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        limit_req zone=ollama_limit burst=20 nodelay;

        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
        add_header Access-Control-Max-Age 3600 always;

        if (\$request_method = 'OPTIONS') {
            return 204;
        }

        set \$auth_ok 0;
        if (\$http_authorization = "Bearer ${API_KEY}") {
            set \$auth_ok 1;
        }
        if (\$uri = /api/tags) {
            set \$auth_ok 1;
        }
        if (\$auth_ok = 0) {
            return 401 '{"error": "Unauthorized. Provide a valid API key in Settings."}';
        }

        proxy_pass http://127.0.0.1:11434;
        proxy_set_header Host localhost;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/eco-nudge /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "=== Getting SSL certificate ==="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || {
    echo "WARNING: certbot failed. You may need to set up DNS first."
    echo "Run manually: sudo certbot --nginx -d $DOMAIN"
}

echo "=== DONE ==="
echo "Frontend: https://${DOMAIN}"
echo "API Key:  ${API_KEY}"
echo "Model:    ${MODEL}"
REMOTE_SCRIPT

# Replace placeholders
sed -i "s|__DOMAIN__|$EFFECTIVE_DOMAIN|g" "$SETUP_SCRIPT"
sed -i "s|__EMAIL__|$EMAIL|g" "$SETUP_SCRIPT"
sed -i "s|__API_KEY__|$API_KEY|g" "$SETUP_SCRIPT"
sed -i "s|__MODEL__|$MODEL|g" "$SETUP_SCRIPT"

# ── 5. Upload project files and run setup ────────────────────────────────────
echo "[5/5] Uploading files and running setup on VM..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Upload frontend files via SSH (create dir first, then SCP)
echo "  Uploading frontend files..."
ssh -o StrictHostKeyChecking=no "azureuser@${PUBLIC_IP}" "mkdir -p /tmp/eco-nudge-src"

for f in index.html app.js eco-data.js styles.css; do
    if [[ -f "$PROJECT_DIR/$f" ]]; then
        scp -o StrictHostKeyChecking=no "$PROJECT_DIR/$f" "azureuser@${PUBLIC_IP}:/tmp/eco-nudge-src/" || {
            echo "  SCP failed for $f — will need manual upload"
        }
    fi
done

# Upload and run the setup script
scp -o StrictHostKeyChecking=no "$SETUP_SCRIPT" "azureuser@${PUBLIC_IP}:/tmp/setup-eco-nudge.sh"
ssh -o StrictHostKeyChecking=no "azureuser@${PUBLIC_IP}" "chmod +x /tmp/setup-eco-nudge.sh && sudo /tmp/setup-eco-nudge.sh"

rm -f "$SETUP_SCRIPT"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✅ Azure Deployment Complete!"
echo ""
echo "  Frontend : https://${EFFECTIVE_DOMAIN}"
echo "  VM IP    : ${PUBLIC_IP}"
echo "  SSH      : ssh azureuser@${PUBLIC_IP}"
echo ""
echo "  Eco-Nudge Settings:"
echo "    Server URL : https://${EFFECTIVE_DOMAIN}"
echo "    API Key    : ${API_KEY}"
echo "    Model      : ${MODEL}"
echo ""
echo "  Cost estimate (Azure for Students):"
echo "    Standard_B2s = FREE for 12 months (750 hrs/mo)"
echo "    Standard_B2ms = ~\$60/mo from \$100 credit"
echo ""
echo "  To stop the VM (save credits when not in use):"
echo "    az vm deallocate -g $RESOURCE_GROUP -n $VM_NAME"
echo "  To start it again:"
echo "    az vm start -g $RESOURCE_GROUP -n $VM_NAME"
echo "  To delete everything:"
echo "    az group delete -g $RESOURCE_GROUP --yes"
echo "══════════════════════════════════════════════════════"
