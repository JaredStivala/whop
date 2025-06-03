// ==================== UPDATED SERVER.JS - MULTI-COMPANY SUPPORT ====================

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Whop Member Directory Server...');

// Environment Variables Check
console.log('🔍 Environment Variables Check:');
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`   PORT: ${port}`);
console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'Set' : 'Missing'}`);
console.log(`   WHOP_API_KEY: ${process.env.WHOP_API_KEY ? 'Set' : 'Missing'}`);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect()
  .then(client => {
    console.log('✅ Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  });

// Helper function to extract company ID from various sources
function extractCompanyId(data) {
  // Try multiple possible fields where company ID might be stored
  return data.company_id || 
         data.companyId || 
         data.business_id || 
         data.businessId || 
         data.hub_id || 
         data.hubId ||
         (data.membership && data.membership.company_id) ||
         (data.membership && data.membership.hub_id) ||
         null;
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API is healthy!', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Basic test endpoint
app.get('/api/test', (req, res) => {
  console.log('📡 API test endpoint called');
  res.json({ 
    success: true, 
    message: 'API is working perfectly!', 
    timestamp: new Date().toISOString(),
    server: 'Whop Member Directory API'
  });
});

// Members endpoint - now properly uses companyId parameter
app.get('/api/members/:companyId', async (req, res) => {
  const { companyId } = req.params;
  
  // Validate company ID format
  if (!companyId || companyId === 'undefined' || companyId === 'null') {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing company ID',
      timestamp: new Date().toISOString()
    });
  }
  
  console.log(`🔍 API: Fetching members for company: ${companyId}`);
  
  try {
    const result = await pool.query(`
      SELECT 
        id, user_id, membership_id, email, name, username, 
        custom_fields, joined_at, status
      FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC
    `, [companyId]);

    console.log(`✅ Found ${result.rows.length} members for company ${companyId}`);

    const members = result.rows.map(member => {
      let parsedCustomFields = {};
      
      if (member.custom_fields) {
        try {
          if (typeof member.custom_fields === 'string') {
            if (member.custom_fields.includes('ActiveRecord') || member.custom_fields.includes('#<')) {
              parsedCustomFields = {
                status: 'Custom fields detected',
                note: 'Upgrade Whop app permissions to see details'
              };
            } else {
              parsedCustomFields = JSON.parse(member.custom_fields);
            }
          } else {
            parsedCustomFields = member.custom_fields;
          }
        } catch (e) {
          parsedCustomFields = {
            error: 'Unable to parse custom fields',
            note: 'Custom field data exists but in an unsupported format'
          };
        }
      }

      return {
        id: member.id,
        user_id: member.user_id,
        membership_id: member.membership_id,
        email: member.email,
        name: member.name,
        username: member.username,
        waitlist_responses: parsedCustomFields,
        custom_fields: parsedCustomFields,
        joined_at: member.joined_at,
        status: member.status
      };
    });

    res.json({
      success: true,
      members: members,
      count: members.length,
      company_id: companyId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Database error in members endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get company info
app.get('/api/company/:companyId', async (req, res) => {
  const { companyId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT DISTINCT company_id, 
      COUNT(*) as member_count,
      MIN(joined_at) as first_member_date,
      MAX(joined_at) as latest_member_date
      FROM whop_members 
      WHERE company_id = $1
      GROUP BY company_id
    `, [companyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Company not found or no members yet',
        company_id: companyId
      });
    }

    res.json({
      success: true,
      company: {
        id: companyId,
        member_count: result.rows[0].member_count,
        first_member_date: result.rows[0].first_member_date,
        latest_member_date: result.rows[0].latest_member_date
      }
    });

  } catch (error) {
    console.error('❌ Error fetching company info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== WEBHOOK ENDPOINT ====================

app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎯 Webhook received from Whop');
    console.log('📋 Webhook data:', JSON.stringify(req.body, null, 2));
    
    const { data, event_type } = req.body;

    if (!data) {
      console.error('❌ No data provided in webhook');
      return res.status(400).json({ error: 'No data provided' });
    }

    // Extract company ID using helper function
    const companyId = extractCompanyId(data);
    
    if (!companyId) {
      console.error('❌ No company ID found in webhook data');
      console.log('📋 Available fields:', Object.keys(data));
      return res.status(400).json({ 
        error: 'No company ID found in webhook data',
        available_fields: Object.keys(data)
      });
    }

    const userId = data.user_id || data.user;
    const membershipId = data.id || data.membership_id;

    if (!userId || !membershipId) {
      console.error('❌ Missing user_id or membership_id');
      return res.status(400).json({ error: 'Missing user_id or membership_id' });
    }

    console.log(`✅ Processing membership for user ${userId} in company ${companyId}`);

    // Handle different event types
    if (event_type === 'membership_went_invalid') {
      // Remove or mark member as inactive
      await pool.query(`
        UPDATE whop_members 
        SET status = 'inactive' 
        WHERE user_id = $1 AND company_id = $2
      `, [userId, companyId]);
      
      console.log(`🔄 Member ${userId} marked as inactive for company ${companyId}`);
      return res.json({ success: true, action: 'member_deactivated' });
    }

    // Fetch user details from Whop API
    let whopUserData = null;
    try {
      if (process.env.WHOP_API_KEY) {
        const userResponse = await fetch(`https://api.whop.com/api/v5/app/users/${userId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (userResponse.ok) {
          whopUserData = await userResponse.json();
          console.log('👤 User data fetched successfully');
        }
      }
    } catch (fetchError) {
      console.warn('⚠️  Could not fetch user data from Whop API:', fetchError.message);
    }

    const email = whopUserData?.email || data.email || null;
    const name = whopUserData?.name || data.name || null;
    const username = whopUserData?.username || data.username || null;

    // Store in database
    const insertQuery = `
      INSERT INTO whop_members (
        user_id, membership_id, company_id, email, name, username, 
        custom_fields, joined_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id, company_id) 
      DO UPDATE SET 
        membership_id = EXCLUDED.membership_id,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        username = EXCLUDED.username,
        custom_fields = EXCLUDED.custom_fields,
        status = EXCLUDED.status,
        joined_at = CASE 
          WHEN whop_members.status = 'inactive' THEN EXCLUDED.joined_at 
          ELSE whop_members.joined_at 
        END
      RETURNING *;
    `;

    const customFields = JSON.stringify(data.custom_field_responses || data.waitlist_responses || {});
    const joinedAt = new Date(data.created_at || Date.now());
    const status = data.status || 'active';

    const result = await pool.query(insertQuery, [
      userId, membershipId, companyId, email, name, username,
      customFields, joinedAt, status
    ]);

    console.log(`🎉 Member stored successfully for company ${companyId}`);
    res.json({ 
      success: true, 
      member: result.rows[0],
      company_id: companyId
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FRONTEND ROUTES ====================

// Main app route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Company-specific directory
app.get('/directory/:companyId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'directory.html'));
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  console.log(`❌ API route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'API endpoint not found',
    path: req.path,
    method: req.method,
    available_endpoints: [
      'GET /api/test',
      'GET /api/health',
      'GET /api/members/:companyId',
      'GET /api/company/:companyId',
      'POST /webhook/whop'
    ]
  });
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================

app.listen(port, () => {
  console.log('');
  console.log('🎉 ===== SERVER STARTED SUCCESSFULLY =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 App URL: https://whopboardy-production.up.railway.app/`);
  console.log(`🔗 Webhook URL: https://whopboardy-production.up.railway.app/webhook/whop`);
  console.log('');
  console.log('🔧 Available API Endpoints:');
  console.log('   GET  /api/test                     - Basic API test');
  console.log('   GET  /api/health                   - Health check');
  console.log('   GET  /api/members/:companyId       - Get members');
  console.log('   GET  /api/company/:companyId       - Get company info');
  console.log('   POST /webhook/whop                 - Whop webhook');
  console.log('');
  console.log('📄 Frontend Routes:');
  console.log('   GET  /                             - Member Directory');
  console.log('   GET  /app                          - Member Directory');
  console.log('   GET  /directory/:companyId         - Company-specific directory');
  console.log('');
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

module.exports = app;