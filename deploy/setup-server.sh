#!/usr/bin/env bash
# =============================================================================
# Eco-Nudge Negotiator — Server Setup Script
# 
# Provisions an Ubuntu 22.04+ server with:
#   1. Ollama (local LLM engine)
#   2. Nginx reverse proxy with HTTPS (Let's Encrypt)
#   3. API-key authentication middleware
#   4. The Eco-Nudge static frontend
#
# Usage:
#   chmod +x setup-server.sh
#   sudo ./setup-server.sh --domain ollama.yourdomain.com --email you@email.com --api-key YOUR_SECRET_KEY
#
# Prerequisites:
#   - Ubuntu 22.04+ server with a public IP
#   - DNS A record pointing your domain to the server IP
#   - Root / sudo access
# =============================================================================

set -euo pipefail

# ── Parse Arguments ──────────────────────────────────────────────────────────
DOMAIN=""
EMAIL=""
API_KEY=""
MODEL="qwen3:4b"

while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)  DOMAIN="$2";  shift 2;;
        --email)   EMAIL="$2";   shift 2;;
        --api-key) API_KEY="$2"; shift 2;;
        --model)   MODEL="$2";   shift 2;;
        *)         echo "Unknown arg: $1"; exit 1;;
    esac
done

if [[ -z "$DOMAIN" || -z "$EMAIL" || -z "$API_KEY" ]]; then
    echo "Usage: sudo $0 --domain <domain> --email <email> --api-key <secret>"
    exit 1
fi

echo "══════════════════════════════════════════════════════"
echo "  Eco-Nudge Server Setup"
echo "  Domain : $DOMAIN"
echo "  Email  : $EMAIL"
echo "  Model  : $MODEL"
echo "══════════════════════════════════════════════════════"

# ── 1. System Updates ────────────────────────────────────────────────────────
echo "[1/6] Updating system packages..."
apt-get update -y && apt-get upgrade -y
apt-get install -y curl nginx certbot python3-certbot-nginx ufw

# ── 2. Firewall ──────────────────────────────────────────────────────────────
echo "[2/6] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 3. Install Ollama ────────────────────────────────────────────────────────
echo "[3/6] Installing Ollama..."
if ! command -v ollama &>/dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
fi

# Configure Ollama to listen on localhost only (Nginx will proxy)
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_ORIGINS=https://${DOMAIN}"
EOF

systemctl daemon-reload
systemctl enable ollama
systemctl restart ollama

# Wait for Ollama to start
echo "  Waiting for Ollama to start..."
for i in {1..30}; do
    if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        echo "  Ollama is running."
        break
    fi
    sleep 2
done

# Pull the model
echo "  Pulling model: $MODEL (this may take a while)..."
ollama pull "$MODEL"

# ── 4. Deploy Static Frontend ───────────────────────────────────────────────
echo "[4/6] Deploying frontend..."
WEBROOT="/var/www/eco-nudge"
mkdir -p "$WEBROOT"

# Copy frontend files (run this script from the project root, or adjust path)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$PROJECT_DIR/index.html" ]]; then
    cp "$PROJECT_DIR/index.html" "$WEBROOT/"
    cp "$PROJECT_DIR/app.js"     "$WEBROOT/"
    cp "$PROJECT_DIR/eco-data.js" "$WEBROOT/"
    cp "$PROJECT_DIR/styles.css"  "$WEBROOT/"
    echo "  Frontend files copied to $WEBROOT"
else
    echo "  WARNING: Frontend files not found at $PROJECT_DIR"
    echo "  You'll need to manually copy index.html, app.js, eco-data.js, styles.css to $WEBROOT"
fi

chown -R www-data:www-data "$WEBROOT"

# ── 5. Nginx Configuration ──────────────────────────────────────────────────
echo "[5/6] Configuring Nginx..."

cat > /etc/nginx/sites-available/eco-nudge <<NGINXEOF
# Rate limiting zone
limit_req_zone \$binary_remote_addr zone=ollama_limit:10m rate=10r/s;

# HTTP-only initially — certbot --nginx will add SSL block and redirect
server {
    listen 80;
    server_name ${DOMAIN};

    # Security headers
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # ── Serve static frontend ──
    root ${WEBROOT};
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # ── Proxy Ollama API with authentication ──
    location /api/ {
        # Rate limiting
        limit_req zone=ollama_limit burst=20 nodelay;

        # CORS
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
        add_header Access-Control-Max-Age 3600 always;

        # Handle preflight
        if (\$request_method = 'OPTIONS') {
            return 204;
        }

        # API key validation
        set \$auth_ok 0;

        # Check Authorization: Bearer <key>
        if (\$http_authorization = "Bearer ${API_KEY}") {
            set \$auth_ok 1;
        }

        # Allow unauthenticated access to /api/tags (connection test only)
        if (\$uri = /api/tags) {
            set \$auth_ok 1;
        }

        if (\$auth_ok = 0) {
            return 401 '{"error": "Unauthorized. Provide a valid API key in Settings."}';
        }

        # Proxy to Ollama
        proxy_pass http://127.0.0.1:11434;
        proxy_set_header Host localhost;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # LLM responses can be slow — generous timeouts
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 10s;

        # Streaming support
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
NGINXEOF

# Enable site
ln -sf /etc/nginx/sites-available/eco-nudge /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

# ── 6. SSL Certificate ──────────────────────────────────────────────────────
echo "[6/6] Obtaining SSL certificate..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✅ Setup Complete!"
echo ""
echo "  Frontend : https://${DOMAIN}"
echo "  Ollama API : https://${DOMAIN}/api/"
echo "  API Key  : ${API_KEY}"
echo "  Model    : ${MODEL}"
echo ""
echo "  Users should set in Eco-Nudge Settings:"
echo "    Server URL : https://${DOMAIN}"
echo "    API Key    : ${API_KEY}"
echo "    Model      : ${MODEL}"
echo ""
echo "  Useful commands:"
echo "    sudo systemctl status ollama"
echo "    sudo systemctl restart ollama"
echo "    ollama list"
echo "    sudo nginx -t && sudo systemctl reload nginx"
echo "    sudo certbot renew --dry-run"
echo "══════════════════════════════════════════════════════"
