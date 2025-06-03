// ==================== COMPLETE FIXED SERVER.JS - MULTI-COMPANY SUPPORT ====================

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

// ==================== HELPER FUNCTIONS ====================

// FIXED: Helper function to extract company ID from webhook data
function extractCompanyId(data) {
  console.log('🔍 Extracting company ID from webhook data...');
  console.log('📋 Available fields:', Object.keys(data));
  
  // Check all possible company ID fields based on your actual webhook logs
  const companyId = 
    data.company_buyer_id ||          // ✅ This was in your webhook logs!
    data.page_id ||                   // Sometimes contains company info  
    data.company_id ||                // Direct field (rare)
    data.business_id ||               // Alternative name
    data.hub_id ||                    // Legacy field
    data.companyId ||                 // Camel case
    data.businessId ||                // Camel case
    // Check nested objects
    data.membership?.company_id ||
    data.product?.company_id ||
    data.checkout?.company_id;
  
  if (companyId) {
    console.log(`✅ Found company ID: ${companyId}`);
    return companyId;
  }
  
  // Try to extract from URLs if present
  if (data.manage_url) {
    const match = data.manage_url.match(/\/(biz_[a-zA-Z0-9]+)/);
    if (match) {
      console.log(`✅ Extracted company ID from URL: ${match[1]}`);
      return match[1];
    }
  }
  
  console.log('❌ No company ID found');
  console.log('📋 Debug values:', {
    company_buyer_id: data.company_buyer_id,
    page_id: data.page_id,
    company_id: data.company_id
  });
  return null;
}

// Function to ensure company exists in whop_companies table
async function ensureCompanyExists(companyId) {
  try {
    // Check if company already exists
    const existingCompany = await pool.query(
      'SELECT id, name FROM whop_companies WHERE company_id = $1',
      [companyId]
    );
    
    if (existingCompany.rows.length > 0) {
      console.log(`✅ Company ${companyId} already exists: ${existingCompany.rows[0].name}`);
      return existingCompany.rows[0];
    }
    
    // Company doesn't exist, create it
    console.log(`➕ Creating new company record: ${companyId}`);
    
    // Try to fetch company details from Whop API if we have an API key
    let companyName = `Company ${companyId}`; // Default name
    let companyData = {};
    
    if (process.env.WHOP_API_KEY) {
      try {
        const response = await fetch(`https://api.whop.com/api/v5/app/companies/${companyId}`, {
          headers: {
            'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          const apiData = await response.json();
          companyName = apiData.title || apiData.name || companyName;
          companyData = {
            title: apiData.title,
            route: apiData.route,
            image_url: apiData.image_url,
            hostname: apiData.hostname
          };
          console.log(`📊 Fetched company details: ${companyName}`);
        }
      } catch (error) {
        console.warn('⚠️ Could not fetch company details from API:', error.message);
      }
    }
    
    // Insert new company
    const result = await pool.query(`
      INSERT INTO whop_companies (
        company_id, name, title, route, image_url, hostname, 
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *
    `, [
      companyId,
      companyName,
      companyData.title || companyName,
      companyData.route || null,
      companyData.image_url || null,
      companyData.hostname || null
    ]);
    
    console.log(`🎉 Created company record: ${companyName}`);
    return result.rows[0];
    
  } catch (error) {
    console.error('❌ Error ensuring company exists:', error);
    throw error;
  }
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

// Get company information
app.get('/api/company/:companyId', async (req, res) => {
  const { companyId } = req.params;
  
  try {
    console.log(`🏢 API: Fetching company info for: ${companyId}`);
    
    // Get company details with member statistics
    const result = await pool.query(`
      SELECT 
        c.*,
        COUNT(m.id) as total_members,
        COUNT(CASE WHEN m.status = 'active' THEN 1 END) as active_members,
        COUNT(CASE WHEN m.joined_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_members_30_days,
        MIN(m.joined_at) as first_member_date,
        MAX(m.joined_at) as latest_member_date
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id
      WHERE c.company_id = $1
      GROUP BY c.id
    `, [companyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Company not found',
        company_id: companyId
      });
    }

    const company = result.rows[0];
    
    console.log(`✅ Found company: ${company.name} with ${company.total_members} members`);

    res.json({
      success: true,
      company: {
        id: company.company_id,
        name: company.name,
        title: company.title,
        route: company.route,
        image_url: company.image_url,
        hostname: company.hostname,
        created_at: company.created_at,
        stats: {
          total_members: parseInt(company.total_members),
          active_members: parseInt(company.active_members),
          new_members_30_days: parseInt(company.new_members_30_days),
          first_member_date: company.first_member_date,
          latest_member_date: company.latest_member_date
        }
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

// Get all companies (admin endpoint)
app.get('/api/companies', async (req, res) => {
  try {
    console.log('🏢 API: Fetching all companies');
    
    const result = await pool.query(`
      SELECT 
        c.*,
        COUNT(m.id) as total_members,
        COUNT(CASE WHEN m.status = 'active' THEN 1 END) as active_members,
        MAX(m.joined_at) as latest_activity
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id
      GROUP BY c.id
      ORDER BY total_members DESC, c.created_at DESC
    `);

    const companies = result.rows.map(row => ({
      id: row.company_id,
      name: row.name,
      title: row.title,
      route: row.route,
      image_url: row.image_url,
      hostname: row.hostname,
      created_at: row.created_at,
      stats: {
        total_members: parseInt(row.total_members),
        active_members: parseInt(row.active_members),
        latest_activity: row.latest_activity
      }
    }));

    console.log(`✅ Found ${companies.length} companies`);

    res.json({
      success: true,
      companies: companies,
      count: companies.length
    });

  } catch (error) {
    console.error('❌ Error fetching companies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get members for a specific company
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
  
  console.log(`👥 API: Fetching members for company: ${companyId}`);
  
  try {
    // First, verify the company exists
    const companyCheck = await pool.query(
      'SELECT name FROM whop_companies WHERE company_id = $1',
      [companyId]
    );

    if (companyCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Company not found. Make sure the company ID is correct.',
        company_id: companyId,
        hint: 'Company must be registered through webhooks first'
      });
    }

    // Get members for this company
    const result = await pool.query(`
      SELECT 
        m.id, m.user_id, m.membership_id, m.email, m.name, m.username, 
        m.custom_fields, m.joined_at, m.status, m.created_at, m.updated_at,
        c.name as company_name
      FROM whop_members m
      JOIN whop_companies c ON m.company_id = c.company_id
      WHERE m.company_id = $1
      ORDER BY m.joined_at DESC
    `, [companyId]);

    console.log(`✅ Found ${result.rows.length} members for company ${companyId} (${companyCheck.rows[0].name})`);

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
        status: member.status,
        created_at: member.created_at,
        updated_at: member.updated_at
      };
    });

    res.json({
      success: true,
      members: members,
      count: members.length,
      company_id: companyId,
      company_name: companyCheck.rows[0].name,
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

// Get directory data (for the frontend)
app.get('/api/directory/:companyId', async (req, res) => {
  const { companyId } = req.params;
  
  try {
    console.log(`📋 API: Fetching directory data for company: ${companyId}`);
    
    // Get company info
    const companyResult = await pool.query(
      'SELECT * FROM whop_companies WHERE company_id = $1',
      [companyId]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Company not found',
        company_id: companyId
      });
    }

    // Get members
    const membersResult = await pool.query(`
      SELECT 
        user_id, membership_id, email, name, username, 
        custom_fields, joined_at, status
      FROM whop_members 
      WHERE company_id = $1 AND status = 'active'
      ORDER BY joined_at DESC
    `, [companyId]);

    const company = companyResult.rows[0];
    const members = membersResult.rows.map(member => {
      let parsedCustomFields = {};
      
      if (member.custom_fields) {
        try {
          parsedCustomFields = typeof member.custom_fields === 'string' 
            ? JSON.parse(member.custom_fields) 
            : member.custom_fields;
        } catch (e) {
          parsedCustomFields = {};
        }
      }

      return {
        user_id: member.user_id,
        membership_id: member.membership_id,
        email: member.email,
        name: member.name,
        username: member.username,
        waitlist_responses: parsedCustomFields,
        joined_at: member.joined_at,
        status: member.status
      };
    });

    console.log(`✅ Directory data: ${company.name} with ${members.length} active members`);

    res.json({
      success: true,
      group: {
        company_id: company.company_id,
        group_name: company.name || company.title,
        name: company.name,
        title: company.title,
        route: company.route,
        image_url: company.image_url
      },
      members: members,
      count: members.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error fetching directory data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug endpoint to see company and member data
app.get('/api/debug/:companyId', async (req, res) => {
  const { companyId } = req.params;
  
  try {
    // Get company data
    const companyResult = await pool.query(
      'SELECT * FROM whop_companies WHERE company_id = $1',
      [companyId]
    );

    // Get member data
    const membersResult = await pool.query(`
      SELECT * FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC
      LIMIT 5
    `, [companyId]);

    res.json({
      success: true,
      debug: {
        company_exists: companyResult.rows.length > 0,
        company_data: companyResult.rows[0] || null,
        member_count: membersResult.rows.length,
        recent_members: membersResult.rows,
        company_id: companyId
      }
    });

  } catch (error) {
    console.error('❌ Debug endpoint error:', error);
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
    console.log('📋 Event type:', req.body.event_type || req.body.action);
    
    const { data, event_type, action } = req.body;

    if (!data) {
      console.error('❌ No data provided in webhook');
      return res.status(400).json({ error: 'No data provided' });
    }

    // Extract company ID using the FIXED function
    const companyId = extractCompanyId(data);
    
    if (!companyId) {
      console.error('❌ No company ID found in webhook data');
      console.log('📋 Available webhook fields:', Object.keys(data));
      console.log('📋 Sample field values:', {
        company_buyer_id: data.company_buyer_id,
        page_id: data.page_id,
        company_id: data.company_id,
        manage_url: data.manage_url
      });
      
      return res.status(400).json({ 
        error: 'No company ID found in webhook data',
        available_fields: Object.keys(data),
        debug_hint: 'Check if company_buyer_id or page_id contains the company ID'
      });
    }

    // ✅ Ensure company exists BEFORE trying to add members
    await ensureCompanyExists(companyId);

    const userId = data.user_id || data.user;
    const membershipId = data.id || data.membership_id;

    if (!userId || !membershipId) {
      console.error('❌ Missing user_id or membership_id');
      return res.status(400).json({ error: 'Missing user_id or membership_id' });
    }

    console.log(`✅ Processing membership for user ${userId} in company ${companyId}`);

    // Handle different event types
    const eventType = event_type || action;
    
    if (eventType === 'membership.went_invalid' || eventType === 'membership_went_invalid') {
      // Mark member as inactive
      const result = await pool.query(`
        UPDATE whop_members 
        SET status = 'inactive', updated_at = NOW() 
        WHERE user_id = $1 AND company_id = $2
        RETURNING *
      `, [userId, companyId]);
      
      console.log(`🔄 Member ${userId} marked as inactive for company ${companyId}`);
      return res.json({ 
        success: true, 
        action: 'member_deactivated',
        member: result.rows[0] 
      });
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
      console.warn('⚠️ Could not fetch user data from Whop API:', fetchError.message);
    }

    // Prepare member data
    const email = whopUserData?.email || data.email || null;
    const name = whopUserData?.name || data.name || null;
    const username = whopUserData?.username || data.username || null;
    const customFields = JSON.stringify(data.custom_field_responses || data.waitlist_responses || {});
    
    // ✅ Handle Unix timestamp conversion correctly
    let joinedAt = new Date();
    if (data.created_at) {
      // If it's a Unix timestamp (seconds), convert to milliseconds
      const timestamp = typeof data.created_at === 'number' ? data.created_at * 1000 : data.created_at;
      joinedAt = new Date(timestamp);
    }
    
    const status = data.valid === true ? 'active' : (data.status || 'active');

    // Store in database
    const insertQuery = `
      INSERT INTO whop_members (
        user_id, membership_id, company_id, email, name, username, 
        custom_fields, joined_at, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      ON CONFLICT (user_id, company_id) 
      DO UPDATE SET 
        membership_id = EXCLUDED.membership_id,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        username = EXCLUDED.username,
        custom_fields = EXCLUDED.custom_fields,
        status = EXCLUDED.status,
        updated_at = NOW(),
        joined_at = CASE 
          WHEN whop_members.status = 'inactive' THEN EXCLUDED.joined_at 
          ELSE whop_members.joined_at 
        END
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      userId, membershipId, companyId, email, name, username,
      customFields, joinedAt, status
    ]);

    console.log(`🎉 Member stored successfully for company ${companyId}`);
    res.json({ 
      success: true, 
      member: result.rows[0],
      company_id: companyId,
      event_type: eventType
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
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
      'GET /api/companies',
      'GET /api/company/:companyId',
      'GET /api/members/:companyId',
      'GET /api/directory/:companyId',
      'GET /api/debug/:companyId',
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
  console.log('   GET  /api/companies                - Get all companies');
  console.log('   GET  /api/company/:companyId       - Get company info');
  console.log('   GET  /api/members/:companyId       - Get members');
  console.log('   GET  /api/directory/:companyId     - Directory data');
  console.log('   GET  /api/debug/:companyId         - Debug endpoint');
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