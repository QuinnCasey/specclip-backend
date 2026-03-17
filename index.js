// SpecClip Backend Service
// Handles OAuth and Google Sheets integration for SpecClip Chrome Extension

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Google OAuth2 Configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// In-memory token storage (in production, use a database)
// Format: { userId: { access_token, refresh_token, expiry_date } }
const tokenStore = new Map();

// ============================================================================
// OAUTH ENDPOINTS
// ============================================================================

/**
 * GET /auth/google
 * Initiates OAuth flow - returns authorization URL
 */
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent' // Force consent screen to get refresh token
  });

  res.json({ authUrl });
});

/**
 * GET /auth/callback
 * OAuth callback - exchanges code for tokens
 */
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code provided' });
  }

  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    
    // Get user info to generate userId
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const userId = userInfo.data.email;

    // Store tokens (in production, encrypt and store in database)
    tokenStore.set(userId, tokens);

    console.log(`✅ User authenticated: ${userId}`);

    // Return success page or redirect to extension
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>SpecClip Connected!</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 12px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.1);
              text-align: center;
              max-width: 400px;
            }
            h1 { color: #667eea; margin: 0 0 20px 0; }
            p { color: #666; line-height: 1.6; }
            .success { font-size: 48px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✅</div>
            <h1>Connected to Google Sheets!</h1>
            <p>SpecClip can now save products to your SpecBooks.</p>
            <p style="margin-top: 30px; font-size: 14px; color: #999;">
              You can close this window and return to the extension.
            </p>
          </div>
          <script>
            // Store userId in localStorage for extension to access
            localStorage.setItem('specclip_user_id', '${userId}');
            // Close window after 3 seconds
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).json({ error: 'Authentication failed', details: error.message });
  }
});

/**
 * POST /auth/verify
 * Verify if user has valid tokens
 */
app.post('/auth/verify', (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  const tokens = tokenStore.get(userId);
  
  if (!tokens) {
    return res.json({ authenticated: false });
  }

  res.json({ 
    authenticated: true,
    userId 
  });
});

// ============================================================================
// GOOGLE SHEETS ENDPOINTS
// ============================================================================

/**
 * Helper: Get authenticated Sheets API client
 */
async function getSheetsClient(userId) {
  const tokens = tokenStore.get(userId);
  
  if (!tokens) {
    throw new Error('User not authenticated');
  }

  // Set credentials
  oauth2Client.setCredentials(tokens);

  // Check if token needs refresh
  const now = Date.now();
  if (tokens.expiry_date && tokens.expiry_date < now) {
    console.log('🔄 Refreshing expired token...');
    const { credentials } = await oauth2Client.refreshAccessToken();
    tokenStore.set(userId, credentials);
    oauth2Client.setCredentials(credentials);
  }

  return google.sheets({ version: 'v4', auth: oauth2Client });
}

/**
 * POST /api/save-product
 * Save product to Google Sheet
 */
app.post('/api/save-product', async (req, res) => {
  try {
    const { userId, sheetId, sheetName, product } = req.body;

    // Validate required fields
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    if (!sheetId) {
      return res.status(400).json({ error: 'sheetId required' });
    }
    if (!sheetName) {
      return res.status(400).json({ error: 'sheetName required' });
    }
    if (!product || !product.productName) {
      return res.status(400).json({ error: 'product.productName required' });
    }

    console.log(`📝 Saving product for user: ${userId}`);
    console.log(`   Sheet ID: ${sheetId}`);
    console.log(`   Sheet Name: ${sheetName}`);
    console.log(`   Product: ${product.productName}`);

    // Get authenticated Sheets client
    const sheets = await getSheetsClient(userId);

    // Get spreadsheet info
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId
    });

    // Find the sheet
    const sheet = spreadsheet.data.sheets?.find(
      s => s.properties?.title === sheetName
    );

    if (!sheet) {
      const availableSheets = spreadsheet.data.sheets
        ?.map(s => s.properties?.title)
        .join(', ');
      throw new Error(
        `Sheet "${sheetName}" not found. Available: ${availableSheets}`
      );
    }

    const sheetTitle = sheet.properties.title;
    const sheetGridProperties = sheet.properties.gridProperties;
    
    // Find insertion row (before footer)
    const lastRow = sheetGridProperties.rowCount;
    let insertRow = lastRow + 1;

    // Check for footer row (contains "SPEC BOOK" in column B)
    const footerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetTitle}!B:B`
    });

    if (footerCheck.data.values) {
      for (let i = footerCheck.data.values.length - 1; i >= 0; i--) {
        const cellValue = footerCheck.data.values[i]?.[0] || '';
        if (cellValue.toString().toUpperCase().includes('SPEC BOOK')) {
          insertRow = i + 1; // Row number (1-indexed)
          console.log(`   Footer found at row ${insertRow}`);
          break;
        }
      }
    }

    // Build row data
    const specs = [
      product.colorFinish,
      product.additionalSpecs
    ].filter(Boolean).join(' | ');

    const dimensionsQty = [
      product.dimensions,
      product.quantity ? `Qty: ${product.quantity}` : ''
    ].filter(Boolean).join('\n');

    const leadTimeComments = [
      product.price,
      product.leadTimeComments
    ].filter(Boolean).join(' | ');

    const siteName = extractSiteName(product.pageUrl || '');
    const timestamp = new Date().toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const rowData = [
      '', // A: Empty (merged)
      '', // B: Empty (merged)
      product.imageUrl ? `=IMAGE("${product.imageUrl}", 1)` : '', // C: Image
      product.roomArea || '', // D: Room/Area
      specs, // E: Specs
      product.productName, // F: Product Name
      siteName, // G: Source (with URL in note)
      dimensionsQty, // H: Dimensions/Qty
      leadTimeComments, // I: Lead Time/Comments
      timestamp, // J: Last Updated
      product.status || 'Clipped' // K: Status
    ];

    // Insert row if needed
    if (insertRow <= lastRow) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: {
                sheetId: sheet.properties.sheetId,
                dimension: 'ROWS',
                startIndex: insertRow - 1,
                endIndex: insertRow
              }
            }
          }]
        }
      });
      console.log(`   Inserted row at ${insertRow}`);
    }

    // Copy formatting from row above
    if (insertRow > 2) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            copyPaste: {
              source: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: insertRow - 2,
                endRowIndex: insertRow - 1,
                startColumnIndex: 0,
                endColumnIndex: 11
              },
              destination: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: insertRow - 1,
                endRowIndex: insertRow,
                startColumnIndex: 0,
                endColumnIndex: 11
              },
              pasteType: 'PASTE_FORMAT'
            }
          }]
        }
      });
    }

    // Write data
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetTitle}!A${insertRow}:K${insertRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowData]
      }
    });

    // Add URL as note on source cell
    if (product.pageUrl) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            updateCells: {
              range: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: insertRow - 1,
                endRowIndex: insertRow,
                startColumnIndex: 6, // Column G
                endColumnIndex: 7
              },
              rows: [{
                values: [{
                  note: product.pageUrl
                }]
              }],
              fields: 'note'
            }
          }]
        }
      });
    }

    // Enable text wrapping for dimensions column
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: insertRow - 1,
              endRowIndex: insertRow,
              startColumnIndex: 7, // Column H
              endColumnIndex: 8
            },
            cell: {
              userEnteredFormat: {
                wrapStrategy: 'WRAP'
              }
            },
            fields: 'userEnteredFormat.wrapStrategy'
          }
        }]
      }
    });

    console.log(`✅ Product saved to row ${insertRow}`);

    res.json({
      status: 'success',
      message: `Product clipped to ${spreadsheet.data.properties.title} / ${sheetName}`,
      row: insertRow,
      sheet: sheetName
    });

  } catch (error) {
    console.error('❌ Error saving product:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to save product'
    });
  }
});

/**
 * GET /api/sheets/:sheetId
 * Get list of sheet names from a spreadsheet
 */
app.get('/api/sheets/:sheetId', async (req, res) => {
  try {
    const { sheetId } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    const sheets = await getSheetsClient(userId);
    
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId
    });

    const sheetNames = spreadsheet.data.sheets?.map(
      s => s.properties?.title
    ) || [];

    res.json({
      spreadsheetName: spreadsheet.data.properties.title,
      sheets: sheetNames
    });

  } catch (error) {
    console.error('Error fetching sheets:', error);
    res.status(500).json({
      error: 'Failed to fetch sheets',
      details: error.message
    });
  }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract site name from URL
 */
function extractSiteName(url) {
  if (!url) return 'Link';
  
  try {
    let hostname = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    hostname = hostname.split('/')[0];
    const parts = hostname.split('.');
    return parts.length > 1 ? parts[0] : hostname;
  } catch (err) {
    return 'Link';
  }
}

// ============================================================================
// HEALTH CHECK & ERROR HANDLING
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'SpecClip Backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: '/auth/google',
      callback: '/auth/callback',
      verify: '/auth/verify',
      saveProduct: 'POST /api/save-product',
      getSheets: 'GET /api/sheets/:sheetId'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n🚀 SpecClip Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`\n⚙️  Environment:`);
  console.log(`   GOOGLE_CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
  console.log(`   GOOGLE_CLIENT_SECRET: ${process.env.GOOGLE_CLIENT_SECRET ? '✅ Set' : '❌ Missing'}`);
  console.log(`   GOOGLE_REDIRECT_URI: ${process.env.GOOGLE_REDIRECT_URI || '❌ Missing'}`);
  console.log('\n');
});

module.exports = app;
