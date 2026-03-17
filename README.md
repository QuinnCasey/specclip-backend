# SpecClip Backend Service

This is the hosted backend service for SpecClip Chrome Extension. It handles OAuth authentication and Google Sheets integration, eliminating the need for users to deploy their own Apps Script code.

## 🎯 What This Does

- **OAuth 2.0 Authentication**: Users authorize SpecClip to access their Google Sheets with one click
- **Google Sheets API**: Writes product data directly to user's SpecBooks
- **Multi-Project Support**: Handles multiple sheet IDs per user
- **Token Management**: Securely stores and refreshes OAuth tokens

## 🚀 Quick Start (Local Development)

### Prerequisites

- Node.js 18+ installed
- Google Cloud Project (for OAuth credentials)

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Google Cloud Project

#### Create Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Create Project"
3. Name it "SpecClip Backend"
4. Click "Create"

#### Enable Google Sheets API

1. In your project, go to **APIs & Services → Library**
2. Search for "Google Sheets API"
3. Click "Enable"

#### Create OAuth 2.0 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **"Create Credentials" → "OAuth client ID"**
3. If prompted, configure OAuth consent screen first:
   - **User Type**: External
   - **App name**: SpecClip
   - **User support email**: your email
   - **Developer contact**: your email
   - Click "Save and Continue"
   - **Scopes**: Add these scopes:
     - `https://www.googleapis.com/auth/spreadsheets`
     - `https://www.googleapis.com/auth/userinfo.email`
   - Click "Save and Continue"
   - **Test users**: Add your email (for testing)
   - Click "Save and Continue"

4. Back to **Credentials**, click **"Create Credentials" → "OAuth client ID"**
5. **Application type**: Web application
6. **Name**: SpecClip Backend
7. **Authorized redirect URIs**:
   - Add: `http://localhost:3000/auth/callback` (for local testing)
   - Add: `https://your-vercel-url.vercel.app/auth/callback` (for production)
8. Click **"Create"**
9. **Copy your Client ID and Client Secret** - you'll need these!

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-abc123xyz
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
PORT=3000
ALLOWED_ORIGINS=*
```

### 4. Run the Server

```bash
npm start
```

You should see:

```
🚀 SpecClip Backend running on port 3000
📍 Health check: http://localhost:3000/health

⚙️  Environment:
   GOOGLE_CLIENT_ID: ✅ Set
   GOOGLE_CLIENT_SECRET: ✅ Set
   GOOGLE_REDIRECT_URI: http://localhost:3000/auth/callback
```

### 5. Test OAuth Flow

1. Open browser: `http://localhost:3000/auth/google`
2. You'll get a JSON response with `authUrl`
3. Copy the `authUrl` and paste in browser
4. Authorize the app
5. You'll be redirected back with success message

✅ Backend is working!

---

## 🌐 Deploy to Vercel (Production)

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Login to Vercel

```bash
vercel login
```

### 3. Deploy

```bash
vercel
```

Follow the prompts:
- **Set up and deploy?** Yes
- **Which scope?** Your personal account
- **Link to existing project?** No
- **Project name?** specclip-backend
- **Directory?** ./
- **Override settings?** No

### 4. Set Environment Variables in Vercel

After deployment, add your environment variables:

```bash
vercel env add GOOGLE_CLIENT_ID
vercel env add GOOGLE_CLIENT_SECRET
vercel env add GOOGLE_REDIRECT_URI
```

For `GOOGLE_REDIRECT_URI`, use your Vercel URL:
```
https://your-project-name.vercel.app/auth/callback
```

### 5. Update Google Cloud OAuth Settings

1. Go back to Google Cloud Console → Credentials
2. Edit your OAuth 2.0 Client ID
3. Add your Vercel URL to **Authorized redirect URIs**:
   ```
   https://your-project-name.vercel.app/auth/callback
   ```
4. Save

### 6. Redeploy

```bash
vercel --prod
```

Your backend is now live! 🎉

**Production URL**: `https://your-project-name.vercel.app`

---

## 📡 API Endpoints

### Authentication

#### `GET /auth/google`
Initiates OAuth flow

**Response:**
```json
{
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

#### `GET /auth/callback`
OAuth callback (redirect URI)

**Query params:**
- `code` - Authorization code from Google

**Returns:** HTML success page

#### `POST /auth/verify`
Verify if user is authenticated

**Body:**
```json
{
  "userId": "user@example.com"
}
```

**Response:**
```json
{
  "authenticated": true,
  "userId": "user@example.com"
}
```

---

### Google Sheets

#### `POST /api/save-product`
Save product to Google Sheet

**Body:**
```json
{
  "userId": "user@example.com",
  "sheetId": "1ABC...XYZ",
  "sheetName": "Lighting",
  "product": {
    "productName": "Table Lamp",
    "price": "$159",
    "imageUrl": "https://...",
    "roomArea": "Living Room",
    "colorFinish": "Brass",
    "additionalSpecs": "Dimmable",
    "dimensions": "10\" x 12\"",
    "quantity": "2",
    "leadTimeComments": "Ships in 2 weeks",
    "pageUrl": "https://...",
    "status": "Clipped"
  }
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Product clipped to My SpecBook / Lighting",
  "row": 12,
  "sheet": "Lighting"
}
```

#### `GET /api/sheets/:sheetId?userId=user@example.com`
Get sheet names from spreadsheet

**Response:**
```json
{
  "spreadsheetName": "My SpecBook",
  "sheets": ["Hardware", "Lighting", "Plumbing"]
}
```

---

### Health Check

#### `GET /`
Service info

#### `GET /health`
Health check endpoint

---

## 🔐 Security Notes

### Token Storage (IMPORTANT)

**Current Implementation (Development):**
- Tokens stored in-memory (Map)
- ⚠️ Tokens lost on server restart
- ⚠️ Not suitable for production

**Production Requirements:**

You MUST implement persistent, encrypted token storage. Options:

**Option 1: Database (Recommended)**
```javascript
// Use PostgreSQL, MongoDB, or Firebase
// Example with Vercel Postgres:
const { sql } = require('@vercel/postgres');

async function storeTokens(userId, tokens) {
  await sql`
    INSERT INTO user_tokens (user_id, tokens, updated_at)
    VALUES (${userId}, ${JSON.stringify(tokens)}, NOW())
    ON CONFLICT (user_id) 
    DO UPDATE SET tokens = ${JSON.stringify(tokens)}, updated_at = NOW()
  `;
}

async function getTokens(userId) {
  const result = await sql`
    SELECT tokens FROM user_tokens WHERE user_id = ${userId}
  `;
  return result.rows[0]?.tokens;
}
```

**Option 2: Vercel KV (Redis)**
```javascript
const { kv } = require('@vercel/kv');

async function storeTokens(userId, tokens) {
  await kv.set(`tokens:${userId}`, tokens);
}

async function getTokens(userId) {
  return await kv.get(`tokens:${userId}`);
}
```

**Option 3: Encrypted Environment**
```javascript
// Use encryption library like 'crypto'
const crypto = require('crypto');

function encryptTokens(tokens, secret) {
  // Implement AES-256-GCM encryption
}

function decryptTokens(encrypted, secret) {
  // Implement decryption
}
```

### CORS Configuration

Update `ALLOWED_ORIGINS` to your extension ID:

```env
ALLOWED_ORIGINS=chrome-extension://your-extension-id-here
```

Get extension ID from `chrome://extensions/`

---

## 📊 Monitoring & Logging

### Vercel Logs

View logs in Vercel dashboard or CLI:

```bash
vercel logs
```

### Custom Logging

The backend logs all important events:
- ✅ User authentications
- 📝 Product saves
- ❌ Errors
- 🔄 Token refreshes

---

## 💰 Cost Estimation

### Vercel Free Tier
- **100GB bandwidth/month** - FREE
- **100 hours of serverless execution** - FREE
- **Automatic HTTPS**
- **Unlimited deployments**

### Realistic Usage (500 users)
- Average: ~10 products/user/month = 5,000 requests
- Each request: ~50KB response
- Total bandwidth: 250MB/month
- **Cost: $0** (well within free tier)

### Scaling Up (5,000 users)
- 50,000 requests/month
- 2.5GB bandwidth
- **Still FREE** on Vercel

### When You Need to Upgrade
- 10,000+ active users
- Consider **Vercel Pro** ($20/month)
- Or self-host on **Railway** ($5/month)

---

## 🧪 Testing

### Manual Testing

1. **Test OAuth:**
   ```bash
   curl http://localhost:3000/auth/google
   ```

2. **Test Save Product:**
   ```bash
   curl -X POST http://localhost:3000/api/save-product \
     -H "Content-Type: application/json" \
     -d '{
       "userId": "test@example.com",
       "sheetId": "YOUR_SHEET_ID",
       "sheetName": "Hardware",
       "product": {
         "productName": "Test Product",
         "price": "$99"
       }
     }'
   ```

### Automated Tests

(Coming soon - add Jest tests)

---

## 🚨 Troubleshooting

### "User not authenticated" error

**Cause:** Tokens not found for user
**Fix:** User needs to authorize again via OAuth flow

### "Failed to refresh token" error

**Cause:** Refresh token expired or invalid
**Fix:** User needs to re-authorize (happens ~6 months)

### "Sheet not found" error

**Cause:** Sheet name doesn't match
**Fix:** Check exact sheet name in Google Sheets (case-sensitive)

### CORS errors in browser

**Cause:** Extension origin not allowed
**Fix:** Add extension ID to `ALLOWED_ORIGINS` environment variable

---

## 📝 Next Steps

### For Production Deployment:

1. ✅ Deploy to Vercel
2. ⚠️ Implement database for token storage
3. ✅ Set up environment variables
4. ✅ Update OAuth redirect URIs
5. ⚠️ Add rate limiting (optional)
6. ⚠️ Add usage analytics (optional)
7. ⚠️ Set up error monitoring (Sentry, etc.)

### For Chrome Extension:

1. Update extension to use backend API
2. Add OAuth flow to extension
3. Remove Apps Script code dependency
4. Test end-to-end flow
5. Publish updated extension

---

## 📞 Support

- **Email:** SpecClipSupport@idco.studio
- **Issues:** GitHub Issues (if open source)
- **Docs:** [Full documentation link]

---

## 📄 License

MIT License - IDCO Studio

---

**Built with ❤️ for interior designers**
