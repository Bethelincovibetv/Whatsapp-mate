# Google Cloud Run & Cloud SQL Deployment Guide

This guide details how to deploy the **Baileys WhatsApp Auto-Tag & Cloud SQL Control Hub** to Google Cloud Run with persistent session storage on Google Cloud SQL (PostgreSQL).

---

## Architecture Overview

1. **WhatsApp Connection**: Maintains a persistent WebSocket to WhatsApp servers using `@whiskeysockets/baileys`.
2. **Session Persistence**: Saves all cryptographic keys (`creds.json`, `pre-keys`, `sessions`, `sender-keys`) into a PostgreSQL database table (`baileys_sessions`). If Cloud Run replaces the container, the new container restores the session instantly without requiring re-pairing.
3. **Cloud Run Minimum Instances**: WhatsApp bot WebSockets require an active process. We configure `--min-instances 1` so Cloud Run does not scale to 0.

---

## Step 1: Provision Google Cloud SQL (PostgreSQL)

Run the following commands using Google Cloud SDK (`gcloud`):

```bash
# 1. Set your GCP project and region
gcloud config set project YOUR_PROJECT_ID
export REGION="us-central1"
export INSTANCE_NAME="baileys-whatsapp-db"
export DB_NAME="baileys_db"
export DB_USER="baileys_admin"
export DB_PASSWORD="YourStrongSecurePassword123!"

# 2. Create the Cloud SQL PostgreSQL instance (v15)
gcloud sql instances create $INSTANCE_NAME \
    --database-version=POSTGRES_15 \
    --tier=db-f1-micro \
    --region=$REGION \
    --root-password=$DB_PASSWORD

# 3. Create the application database
gcloud sql databases create $DB_NAME --instance=$INSTANCE_NAME

# 4. Create database user
gcloud sql users create $DB_USER \
    --instance=$INSTANCE_NAME \
    --password=$DB_PASSWORD

# 5. Retrieve the Instance Connection Name (format: PROJECT:REGION:INSTANCE)
export INSTANCE_CONNECTION_NAME=$(gcloud sql instances describe $INSTANCE_NAME --format="value(connectionName)")
echo "Instance Connection Name: $INSTANCE_CONNECTION_NAME"
```

### Apply Table Schema (`schema.sql`)
The application automatically executes `CREATE TABLE IF NOT EXISTS baileys_sessions ...` on startup. If you wish to apply it manually via `psql` or Cloud Shell:

```bash
gcloud sql connect $INSTANCE_NAME --user=$DB_USER --database=$DB_NAME < schema.sql
```

---

## Step 2: Configure Service Account Permissions

Cloud Run requires permission to connect to Cloud SQL:

```bash
# Get your Cloud Run default service account or create a dedicated one
export PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)")
export CLOUD_RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Grant Cloud SQL Client role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:${CLOUD_RUN_SA}" \
    --role="roles/cloudsql.client"
```

---

## Step 3: Deploy to Google Cloud Run

Deploy the container using Cloud Build:

```bash
# Deploy to Cloud Run
gcloud run deploy whatsapp-autotag-service \
    --source . \
    --region $REGION \
    --platform managed \
    --allow-unauthenticated \
    --add-cloudsql-instances $INSTANCE_CONNECTION_NAME \
    --set-env-vars INSTANCE_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME \
    --set-env-vars DB_NAME=$DB_NAME \
    --set-env-vars DB_USER=$DB_USER \
    --set-env-vars DB_PASSWORD=$DB_PASSWORD \
    --set-env-vars AUTO_TAG_ENABLED=true \
    --set-env-vars AUTO_TAG_TRIGGER=all \
    --set-env-vars TAG_COOLDOWN_SECONDS=3 \
    --min-instances 1 \
    --max-instances 1 \
    --cpu 1 \
    --memory 1Gi \
    --timeout 3600 \
    --port 3000
```

> **Important Cloud Run Flags Explained:**
> - `--min-instances 1`: Keeps at least 1 instance alive at all times to maintain the active WhatsApp WebSocket connection.
> - `--max-instances 1`: Prevents multiple containers from connecting with the same WhatsApp session simultaneously (WhatsApp only allows one active socket per session ID).
> - `--add-cloudsql-instances`: Automatically sets up the Cloud SQL Auth Proxy Unix socket at `/cloudsql/$INSTANCE_CONNECTION_NAME`.
> - `--cpu-boost`: Speeds up cold-starts.

---

## Step 4: Pair with WhatsApp via Phone Number

1. Open your deployed Cloud Run URL:
   `https://whatsapp-autotag-service-xxx-uc.a.run.app`
2. In the Control Dashboard, enter your WhatsApp phone number with country code (e.g. `14155552671`).
3. Click **"Request Pairing Code"**.
4. An 8-character code will appear (e.g., `ABCD-EFGH`).
5. On your phone:
   - Open **WhatsApp** > **Settings** (or 3 dots) > **Linked Devices**
   - Tap **"Link a Device"**
   - Tap **"Link with phone number instead"**
   - Enter the 8-character code.
6. The dashboard will immediately show **"Connected"**. All keys are saved directly into your Google Cloud SQL PostgreSQL database!

---

## Step 5: Test the API Endpoint (`POST /send-broadcast`)

Send a broadcast that tags everyone in a group using cURL:

```bash
curl -X POST https://YOUR-CLOUD-RUN-URL/send-broadcast \
  -H "Content-Type: application/json" \
  -d '{
    "groupJid": "120363024890123456@g.us",
    "message": "Hello team! Emergency meeting in Room 4 at 2:00 PM."
  }'
```

Response:
```json
{
  "success": true,
  "groupJid": "120363024890123456@g.us",
  "groupSubject": "Engineering Ops",
  "recipientCount": 48,
  "messageId": "BAE58A32145A67"
}
```
All 48 group members will receive an announcement quoting your text and tagging their handles!
