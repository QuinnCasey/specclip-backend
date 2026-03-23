// SpecClip Backend Service
// Handles OAuth and Google Sheets integration for SpecClip Chrome Extension

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { sql } = require('@vercel/postgres');
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

// ============================================================================
// DATABASE SETUP
// ============================================================================

/**
 * Initialize database table for token storage
 */
async function initDatabase() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS user_tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expiry_date BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log('✅ Database table ready');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
}

// Initialize database on startup
initDatabase();

/**
 * Store tokens in database
 */
async function storeTokens(userId, tokens) {
  try {
    await sql`
      INSERT INTO user_tokens (user_id, access_token, refresh_token, expiry_date, updated_at)
      VALUES (${userId}, ${tokens.access_token}, ${tokens.refresh_token || null}, ${tokens.expiry_date || null}, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        access_token = ${tokens.access_token},
        refresh_token = COALESCE(${tokens.refresh_token}, user_tokens.refresh_token),
        expiry_date = ${tokens.expiry_date || null},
        updated_at = CURRENT_TIMESTAMP
    `;
    console.log(`✅ Tokens stored for ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Error storing tokens:', error);
    return false;
  }
}

/**
 * Retrieve tokens from database
 */
async function getTokens(userId) {
  try {
    const result = await sql`
      SELECT access_token, refresh_token, expiry_date 
      FROM user_tokens 
      WHERE user_id = ${userId}
    `;
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expiry_date: row.expiry_date
    };
  } catch (error) {
    console.error('❌ Error retrieving tokens:', error);
    return null;
  }
}

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

    // Store tokens in database
    await storeTokens(userId, tokens);

    console.log(`✅ User authenticated: ${userId}`);

    // Return success page that communicates with extension
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
              This window will close in 3 seconds...
            </p>
          </div>
          <script>
            // Add userId to URL so extension can detect it
            const userId = '${userId}';
            window.location.hash = 'success=' + encodeURIComponent(userId);
            
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
app.post('/auth/verify', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  const tokens = await getTokens(userId);
  
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
 * Apply row formatting based on Apps Script rules
 * Preserves data validation in columns K and L, and row height
 */
async function applyRowFormatting(sheets, sheetId, sheet, rowNumber) {
  const DATE_FORMAT = "MM/DD/YYYY";
  const FONT_FAMILY = "Karla";
  
  // First, get the data validation AND row height from the row above (if exists)
  let dataValidations = {};
  let rowHeight = null;
  
  if (rowNumber > 2) {
    try {
      const sourceRow = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
        ranges: [`${sheet.properties.title}!K${rowNumber - 1}:L${rowNumber - 1}`],
        fields: 'sheets(data(rowData(values(dataValidation)),rowMetadata))'
      });
      
      // Safely navigate the response structure
      const sheetsData = sourceRow?.data?.sheets;
      if (sheetsData && sheetsData.length > 0) {
        const sheetData = sheetsData[0]?.data;
        if (sheetData && sheetData.length > 0) {
          const rowDataArray = sheetData[0]?.rowData;
          if (rowDataArray && rowDataArray.length > 0) {
            const rowData = rowDataArray[0];
            
            // Get data validation from columns K and L
            if (rowData?.values) {
              // Column K (index 0 in the K:L range)
              if (rowData.values[0]?.dataValidation) {
                dataValidations[10] = rowData.values[0].dataValidation;
              }
              // Column L (index 1 in the K:L range)
              if (rowData.values[1]?.dataValidation) {
                dataValidations[11] = rowData.values[1].dataValidation;
              }
            }
          }
          
          // Get row height from rowMetadata
          const rowMetadata = sheetData[0]?.rowMetadata;
          if (rowMetadata && rowMetadata.length > 0 && rowMetadata[0]?.pixelSize) {
            rowHeight = rowMetadata[0].pixelSize;
          }
        }
      }
    } catch (error) {
      console.error('Error fetching data validation/row height:', error);
      // Continue without data validation - don't fail the save
    }
  }
  
  // Column formatting rules (1-indexed, matching new sheet structure)
  const columnFormats = {
    2:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: false, numberFormat: null, horizontalAlignment: "CENTER" }, // B: Image (skipped in loop)
    3:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER" }, // C: Room/Area
    4:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER" }, // D: Specs
    5:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER" }, // E: Product Name
    6:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER", foregroundColor: { red: 0, green: 0, blue: 0 }, underline: false }, // F: Source (hyperlink styled black, no underline)
    7:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER" }, // G: Dimensions/Qty
    8:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER" }, // H: Lead Time
    9:  { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: true,  numberFormat: null, horizontalAlignment: "CENTER" }, // I: Comments
    10: { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: false, numberFormat: DATE_FORMAT, horizontalAlignment: "CENTER" }, // J: Timestamp
    11: { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: false, numberFormat: null, horizontalAlignment: "LEFT" },  // K: Status
    12: { background: { red: 1, green: 1, blue: 1 }, fontSize: 10, bold: false, wrap: false, numberFormat: null, horizontalAlignment: "LEFT" }   // L: Dropdown (preserved)
  };
  
  const requests = [];
  
  // Set row height if we have it
  if (rowHeight) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: sheet.properties.sheetId,
          dimension: "ROWS",
          startIndex: rowNumber - 1,
          endIndex: rowNumber
        },
        properties: {
          pixelSize: rowHeight
        },
        fields: "pixelSize"
      }
    });
  }
  
  // Apply formatting to each column
  for (const [col, fmt] of Object.entries(columnFormats)) {
    const colNum = Number(col);
    
    // Skip column 2 (image column — =IMAGE formula, no text formatting)
    if (colNum === 2) continue;
    
    const textFormat = {
      fontFamily: FONT_FAMILY,
      fontSize: fmt.fontSize,
      bold: fmt.bold
    };
    if (fmt.foregroundColor !== undefined) textFormat.foregroundColor = fmt.foregroundColor;
    if (fmt.underline !== undefined) textFormat.underline = fmt.underline;

    const cellFormat = {
      backgroundColor: fmt.background,
      textFormat,
      horizontalAlignment: fmt.horizontalAlignment,
      wrapStrategy: fmt.wrap ? "WRAP" : "OVERFLOW_CELL"
    };
    
    if (fmt.numberFormat) {
      cellFormat.numberFormat = {
        type: "DATE",
        pattern: fmt.numberFormat
      };
    }
    
    // Build the cell object
    const cellData = {
      userEnteredFormat: cellFormat
    };
    
    // Add data validation if it exists for this column (separate from format)
    const validationKey = colNum - 1; // Convert to 0-indexed
    if (dataValidations[validationKey]) {
      cellData.dataValidation = dataValidations[validationKey];
    }
    
    const fields = dataValidations[validationKey]
      ? "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy,numberFormat),dataValidation"
      : "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy,numberFormat)";
    
    requests.push({
      repeatCell: {
        range: {
          sheetId: sheet.properties.sheetId,
          startRowIndex: rowNumber - 1,
          endRowIndex: rowNumber,
          startColumnIndex: colNum - 1,
          endColumnIndex: colNum
        },
        cell: cellData,
        fields: fields
      }
    });
  }
  
  // Merge A:B for the image cell
  requests.push({
    mergeCells: {
      range: {
        sheetId: sheet.properties.sheetId,
        startRowIndex: rowNumber - 1,
        endRowIndex: rowNumber,
        startColumnIndex: 0, // Column A
        endColumnIndex: 2    // Through Column B
      },
      mergeType: "MERGE_ALL"
    }
  });

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests }
    });
    console.log(`   ✅ Applied formatting to row ${rowNumber} (with data validation and row height preserved)`);
  }
}

/**
 * Helper: Get authenticated Sheets API client
 */
async function getSheetsClient(userId) {
  const tokens = await getTokens(userId);
  
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
    await storeTokens(userId, credentials);
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
    console.log(`   Product fields:`, JSON.stringify(product, null, 2));

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

    // Check for footer row (contains "SPEC BOOK" in any of columns A–C)
    const footerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetTitle}!A:C`
    });

    if (footerCheck.data.values) {
      for (let i = footerCheck.data.values.length - 1; i >= 0; i--) {
        const rowCells = footerCheck.data.values[i] || [];
        const rowText = rowCells.join(' ').toUpperCase();
        if (rowText.includes('SPEC BOOK')) {
          insertRow = i + 1; // Row number (1-indexed)
          console.log(`   Footer found at row ${insertRow}`);
          break;
        }
      }
    }

    // Build row data with new mapping
    const specs = [
      product.colorFinish,
      product.additionalSpecs
    ].filter(Boolean).join(' | ');

    // Dimensions | Qty (combined with pipe separator)
    const dimensionsQty = [
      product.dimensions,
      product.quantity ? `Qty: ${product.quantity}` : ''
    ].filter(Boolean).join('\n');

    const siteName = extractSiteName(product.pageUrl || '');
    const sourceCell = product.pageUrl
      ? `=HYPERLINK("${product.pageUrl}","${siteName.replace(/"/g, '""')}")`
      : siteName;

    const timestamp = new Date().toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    console.log(`   imageUrl: ${product.imageUrl}`);
    console.log(`   leadTime: ${product.leadTime}, comments: ${product.comments}`);

    const rowData = [
      product.imageUrl ? `=IMAGE("${product.imageUrl}", 1)` : '', // A: Image (A:B merged)
      '', // B: Empty (merged with A)
      product.roomArea || '', // C: Room/Area
      specs, // D: Specs (colorFinish + additionalSpecs)
      product.productName, // E: Product Name
      sourceCell, // F: Source (hyperlink)
      dimensionsQty, // G: Dimensions/Qty
      product.leadTime || product.leadTimeComments || '', // H: Lead Time
      product.comments || '', // I: Comments
      timestamp, // J: Last Updated
      product.status || 'Sourced' // K: Status
    ];

    // Insert a row — inheritFromBefore allows appending at end of grid and copies format from row above
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
            },
            inheritFromBefore: insertRow > 1
          }
        }]
      }
    });
    console.log(`   Inserted row at ${insertRow}`);

    // Write data
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetTitle}!A${insertRow}:L${insertRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowData]
      }
    });


    // Apply comprehensive row formatting (Karla font, date formats, wrapping, etc.)
    await applyRowFormatting(sheets, sheetId, sheet, insertRow);

    console.log(`✅ Product saved to row ${insertRow}`);

    res.json({
      status: 'success',
      message: `Product clipped to ${spreadsheet.data.properties.title} / ${sheetName}`,
      row: insertRow,
      sheet: sheetName
    });

  } catch (error) {
    console.error('❌ Error saving product:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to save product',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
