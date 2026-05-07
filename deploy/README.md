# Deploying Eco-Nudge with a Remote Ollama Server

This guide covers deploying the Eco-Nudge Negotiator so users connect to a hosted Ollama instance instead of running one locally.

## Architecture

```
┌─────────────────┐       HTTPS        ┌──────────────────────────────┐
│   User Browser  │ ◄──────────────── │  Your Server (Ubuntu)        │
│                 │ ──────────────── │                              │
│  Eco-Nudge SPA  │    /api/*  ──── │  Nginx (reverse proxy)      │
└─────────────────┘                    │    │                        │
                                       │    └──► Ollama (:11434)     │
                                       │         └── qwen3:4b model  │
                                       └──────────────────────────────┘
```

- **Nginx** serves the static frontend files AND proxies `/api/*` to Ollama
- **Ollama** runs only on `127.0.0.1` (not exposed to the internet directly)
- **API key** auth is enforced at the Nginx layer
- **HTTPS** via Let's Encrypt (certbot)

---

## Option A: Automated Setup Script (Bare Metal / VPS)

### Prerequisites

- Ubuntu 22.04+ server with a public IP
- A domain name with an A record pointing to your server
- SSH access with sudo

### Steps

```bash
# 1. SSH into your server
ssh root@your-server-ip

# 2. Clone or upload your project
git clone <your-repo> /opt/eco-nudge
cd /opt/eco-nudge

# 3. Run the setup script
chmod +x deploy/setup-server.sh
sudo ./deploy/setup-server.sh \
  --domain ollama.yourdomain.com \
  --email  you@email.com \
  --api-key $(openssl rand -hex 32) \
  --model  qwen3:4b
```

The script will:
1. Install Ollama and pull your model
2. Configure Ollama as a systemd service (localhost only)
3. Install and configure Nginx with HTTPS
4. Set up API key authentication
5. Deploy the static frontend

### After Setup

Give users these settings for the Eco-Nudge Settings page:
- **Server URL**: `https://ollama.yourdomain.com`
- **API Key**: the key you generated
- **Model**: `qwen3:4b` (or whichever you pulled)

---

## Option B: Azure for Students (Free VM)

Best if you have Azure for Students benefits ($100 credit + free-tier VMs).

### What You Get Free

| Resource | Free Allowance |
|----------|---------------|
| **Standard_B2s VM** (2 vCPU, 4 GB RAM) | 750 hours/month for 12 months |
| **Public IP** | Included with VM |
| **Azure DNS label** | Free (`yourname.eastus.cloudapp.azure.com`) |
| **64 GB managed disk** | Included |

The **B2s** (4 GB RAM) runs smaller models like `qwen3:0.6b` and `qwen3:1.7b` well.
For `qwen3:4b` or larger, upgrade to **B2ms** (8 GB, ~$60/mo from your $100 credit).

### Prerequisites

1. **Activate Azure for Students**: [azure.microsoft.com/en-us/free/students](https://azure.microsoft.com/en-us/free/students) — no credit card required
2. **Install Azure CLI**:
   ```bash
   # Windows (PowerShell)
   winget install Microsoft.AzureCLI
   
   # macOS
   brew install azure-cli
   
   # Ubuntu/WSL
   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
   ```
3. **Log in**: `az login`

### Automated Deployment

```bash
chmod +x deploy/deploy-azure.sh

# Minimal (uses free B2s VM + Azure DNS label — no custom domain needed)
./deploy/deploy-azure.sh \
  --email you@edu.email.com

# With custom domain
./deploy/deploy-azure.sh \
  --email  you@edu.email.com \
  --domain ollama.yourdomain.com

# With a larger VM for bigger models
./deploy/deploy-azure.sh \
  --email    you@edu.email.com \
  --vm-size  Standard_B2ms \
  --model    qwen3:4b
```

The script will:
1. Create a resource group and Ubuntu VM
2. Assign a public DNS label (e.g., `eco-nudge-12345.eastus.cloudapp.azure.com`)
3. SSH into the VM and install Ollama + Nginx + HTTPS
4. Upload your frontend files
5. Print the URL and API key

### Manual Setup (Step by Step)

If you prefer to set it up manually:

```bash
# 1. Create resource group
az group create --name eco-nudge-rg --location eastus

# 2. Create VM (B2s = free for students)
az vm create \
  --resource-group eco-nudge-rg \
  --name eco-nudge-vm \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_B2s \
  --admin-username azureuser \
  --generate-ssh-keys

# 3. Open web ports
az vm open-port -g eco-nudge-rg -n eco-nudge-vm --port 80  --priority 1010
az vm open-port -g eco-nudge-rg -n eco-nudge-vm --port 443 --priority 1020

# 4. Get the VM's public IP
az vm show -g eco-nudge-rg -n eco-nudge-vm -d --query publicIps -o tsv

# 5. SSH in and run the generic setup script
scp index.html app.js eco-data.js styles.css deploy/setup-server.sh azureuser@<IP>:/tmp/
ssh azureuser@<IP>
sudo /tmp/setup-server.sh --domain <your-domain> --email <email> --api-key $(openssl rand -hex 32)
```

### Saving Credits — Start/Stop the VM

```bash
# Stop VM (stops billing for compute hours)
az vm deallocate -g eco-nudge-rg -n eco-nudge-vm

# Start VM again
az vm start -g eco-nudge-rg -n eco-nudge-vm

# Delete everything when done
az group delete -g eco-nudge-rg --yes
```

> **Tip**: If the VM is only for class demos, deallocate it between uses. The B2s free tier gives 750 hours/month (~31 days of 24/7), so for a single VM you won't be charged anyway. But deallocating is still good practice.

### Azure Model Recommendations

| VM Size | RAM | Monthly Cost | Best Models |
|---------|-----|-------------|-------------|
| **Standard_B2s** (free) | 4 GB | $0 | qwen3:0.6b, qwen3:1.7b, gemma3:1b |
| **Standard_B2ms** | 8 GB | ~$60 | qwen3:4b, phi4-mini |
| **Standard_B4ms** | 16 GB | ~$120 | mistral 7B, llama3.2 |

---

## Option C: Docker Compose

Best if you prefer containerized deployment.

### Prerequisites

- Docker and Docker Compose installed
- (Optional) NVIDIA Container Toolkit for GPU acceleration

### Steps

```bash
cd /opt/eco-nudge

# Start everything
docker compose -f deploy/docker-compose.yml up -d

# Pull your model into the Ollama container
docker compose -f deploy/docker-compose.yml exec ollama ollama pull qwen3:4b

# Check status
docker compose -f deploy/docker-compose.yml ps
```

The app will be available at `http://your-server-ip`. For HTTPS, uncomment the certbot service in `docker-compose.yml` and update `nginx.conf` with your domain.

### GPU Support

Uncomment the `deploy.resources.reservations` section in `docker-compose.yml`:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

---

## Server Sizing Recommendations

| Model | Min RAM | Recommended | GPU |
|-------|---------|-------------|-----|
| qwen3:0.6b | 2 GB | 4 GB | Not needed |
| qwen3:1.7b | 4 GB | 8 GB | Optional |
| qwen3:4b | 6 GB | 8 GB | Recommended |
| mistral (7B) | 8 GB | 16 GB | Recommended |
| llama3.2 (8B) | 10 GB | 16 GB | Strongly recommended |

**Cloud provider recommendations:**
- **Budget**: DigitalOcean Droplet ($24/mo, 8GB RAM, CPU-only with smaller models)
- **GPU**: Lambda Labs, RunPod, or AWS `g4dn.xlarge`
- **Free tier**: Oracle Cloud free ARM instance (24GB RAM — runs 7B models well)

---

## Managing Models

```bash
# List installed models
ollama list

# Pull a new model
ollama pull gemma3

# Remove a model
ollama rm mistral

# Check Ollama status
systemctl status ollama        # bare metal
docker compose logs ollama     # Docker
```

---

## Security Notes

1. **API key**: The setup script generates or uses your provided key. Change it with:
   ```bash
   # Edit the Nginx config and replace the API_KEY value
   sudo nano /etc/nginx/sites-available/eco-nudge
   sudo nginx -t && sudo systemctl reload nginx
   ```

2. **Ollama is localhost-only**: It never accepts direct external connections. All traffic goes through Nginx.

3. **Rate limiting**: Nginx limits API requests to 10/second per IP with a burst of 20.

4. **HTTPS**: Certbot auto-renews certificates. Verify with:
   ```bash
   sudo certbot renew --dry-run
   ```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Cannot reach Ollama" in the app | Check `systemctl status ollama` or `docker compose logs ollama` |
| 401 Unauthorized | Verify the API key in Settings matches the one in Nginx config |
| Model not found | Run `ollama pull <model-name>` on the server |
| Slow responses | Use a smaller model, add GPU, or increase server RAM |
| CORS errors | Ensure `OLLAMA_ORIGINS` includes your domain |
| SSL certificate issues | Run `sudo certbot renew` and reload Nginx |
