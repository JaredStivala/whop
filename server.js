const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Whop Member Directory Server...');

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
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
  });

// ==================== SIMPLIFIED API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is healthy!', 
    timestamp: new Date().toISOString()
  });
});

// Get members by company name - SIMPLIFIED
app.get('/api/members/:companyName', async (req, res) => {
  const { companyName } = req.params;
  
  // Set content type to JSON explicitly
  res.setHeader('Content-Type', 'application/json');
  
  try {
    console.log(`🔍 Looking up company: "${companyName}"`);
    
    // Test database connection first
    try {
      await pool.query('SELECT 1');
      console.log('✅ Database connection verified');
    } catch (dbError) {
      console.error('❌ Database connection failed:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Database connection failed',
        details: dbError.message
      });
    }
    
    // Step 1: Find company_id from company_name (case insensitive)
    const companyQuery = `
      SELECT company_id, company_name 
      FROM whop_companies 
      WHERE LOWER(company_name) = LOWER($1)
    `;
    
    console.log(`📋 Executing query: ${companyQuery} with param: ${companyName}`);
    const companyResult = await pool.query(companyQuery, [companyName]);
    console.log(`📋 Company query result: ${companyResult.rows.length} rows`);

    if (companyResult.rows.length === 0) {
      console.log(`❌ Company "${companyName}" not found`);
      
      // Show available companies for debugging
      try {
        const allCompanies = await pool.query('SELECT company_name FROM whop_companies LIMIT 10');
        console.log('📋 Available companies:', allCompanies.rows.map(row => row.company_name));
        
        return res.status(404).json({
          success: false,
          error: `Company "${companyName}" not found`,
          available_companies: allCompanies.rows.map(row => row.company_name),
          searched_for: companyName
        });
      } catch (listError) {
        console.error('❌ Error listing companies:', listError);
        return res.status(404).json({
          success: false,
          error: `Company "${companyName}" not found`,
          searched_for: companyName,
          note: 'Could not list available companies due to database error'
        });
      }
    }

    const company = companyResult.rows[0];
    const companyId = company.company_id;
    
    console.log(`✅ Found company: ${companyName} -> ${companyId}`);

    // Step 2: Get all members for this company_id
    const membersQuery = `
      SELECT * FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC NULLS LAST
    `;
    
    console.log(`📋 Executing members query for company_id: ${companyId}`);
    const membersResult = await pool.query(membersQuery, [companyId]);
    console.log(`✅ Found ${membersResult.rows.length} members for ${companyName}`);

    // Format members data
    const members = membersResult.rows.map(member => {
      let customFields = {};
      if (member.custom_fields) {
        try {
          if (typeof member.custom_fields === 'string') {
            customFields = JSON.parse(member.custom_fields);
          } else {
            customFields = member.custom_fields;
          }
        } catch (parseError) {
          console.warn('❌ Error parsing custom_fields for member:', member.id);
          customFields = {};
        }
      }

      return {
        id: member.id,
        user_id: member.user_id,
        membership_id: member.membership_id,
        email: member.email,
        name: member.name,
        username: member.username,
        custom_fields: customFields,
        joined_at: member.joined_at,
        status: member.status || 'active'
      };
    });

    const response = {
      success: true,
      company_name: companyName,
      company_id: companyId,
      members: members,
      count: members.length,
      timestamp: new Date().toISOString()
    };
    
    console.log(`✅ Sending response with ${members.length} members`);
    res.json(response);

  } catch (error) {
    console.error('❌ Error in members lookup:', error);
    console.error('❌ Stack trace:', error.stack);
    
    res.status(500).json({
      success: false,
      error: error.message,
      company_name: companyName,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Debug endpoint to see all companies
app.get('/api/companies', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.company_id, 
        c.company_name,
        COUNT(m.id) as member_count
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id
      GROUP BY c.company_id, c.company_name
      ORDER BY c.company_name
    `);
    res.json({
      success: true,
      companies: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// BACKWARD COMPATIBILITY: Old endpoint that your frontend is calling
app.get('/api/directory/:companyName', async (req, res) => {
  const { companyName } = req.params;
  
  try {
    console.log(`🔍 [OLD API] Looking up company: "${companyName}"`);
    
    // Step 1: Find company_id from company_name (case insensitive)
    const companyQuery = `
      SELECT company_id, company_name 
      FROM whop_companies 
      WHERE LOWER(company_name) = LOWER($1)
    `;
    
    const companyResult = await pool.query(companyQuery, [companyName]);

    if (companyResult.rows.length === 0) {
      console.log(`❌ Company "${companyName}" not found`);
      
      // Show available companies for debugging
      const allCompanies = await pool.query('SELECT company_name, company_id FROM whop_companies LIMIT 10');
      console.log('📋 Available companies:', allCompanies.rows);
      
      return res.status(404).json({
        success: false,
        error: `Company "${companyName}" not found`,
        available_companies: allCompanies.rows,
        searched_for: companyName
      });
    }

    const company = companyResult.rows[0];
    const companyId = company.company_id;
    
    console.log(`✅ Found company: ${companyName} -> ${companyId}`);

    // Step 2: Get all members for this company_id
    const membersQuery = `
      SELECT * FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC NULLS LAST
    `;
    
    const membersResult = await pool.query(membersQuery, [companyId]);
    console.log(`✅ Found ${membersResult.rows.length} members for ${companyName}`);

    // Format members data
    const members = membersResult.rows.map(member => {
      let customFields = {};
      if (member.custom_fields) {
        try {
          if (typeof member.custom_fields === 'string') {
            customFields = JSON.parse(member.custom_fields);
          } else {
            customFields = member.custom_fields;
          }
        } catch (parseError) {
          console.warn('❌ Error parsing custom_fields for member:', member.id);
          customFields = {};
        }
      }

      return {
        id: member.id,
        user_id: member.user_id,
        membership_id: member.membership_id,
        email: member.email,
        name: member.name,
        username: member.username,
        custom_fields: customFields,
        joined_at: member.joined_at,
        status: member.status || 'active'
      };
    });

    res.json({
      success: true,
      company_name: companyName,
      company_id: companyId,
      members: members,
      count: members.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in directory lookup:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      company_name: companyName
    });
  }
});

// ==================== WHOP WEBHOOK (unchanged) ====================
app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎯 Webhook received from Whop');
    const { data, event_type } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'No data provided' });
    }

    const companyId = data.company_buyer_id || data.page_id || data.company_id;
    const userId = data.user_id || data.user;
    const membershipId = data.id || data.membership_id;

    if (!companyId || !userId || !membershipId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Handle member deactivation
    if (event_type === 'membership.went_invalid' || event_type === 'membership_went_invalid') {
      await pool.query(`
        UPDATE whop_members 
        SET status = 'inactive', updated_at = NOW() 
        WHERE user_id = $1 AND company_id = $2
      `, [userId, companyId]);
      
      console.log(`🔄 Member ${userId} deactivated for company ${companyId}`);
      return res.json({ success: true, action: 'member_deactivated' });
    }

    // Add/update member
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
        updated_at = NOW()
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      userId, 
      membershipId, 
      companyId, 
      data.email || null,
      data.name || null,
      data.username || null,
      JSON.stringify(data.custom_field_responses || {}),
      new Date(),
      'active'
    ]);

    console.log(`🎉 Member stored for company ${companyId}`);
    res.json({ success: true, member: result.rows[0] });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FRONTEND ROUTES ====================

// Serve test/debug page
app.get('/test.html', (req, res) => {
  console.log('📄 Serving test.html');
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Serve directory page with company name from URL
app.get('/directory/:companyName', (req, res) => {
  console.log(`📄 Serving directory for company: ${req.params.companyName}`);
  res.sendFile(path.join(__dirname, 'public', 'directory.html'));
});

// Serve main page
app.get('/', (req, res) => {
  console.log('📄 Serving index.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all for other routes - MUST BE LAST
app.get('*', (req, res) => {
  console.log(`📄 Catch-all route for: ${req.path}`);
  // Only serve HTML for non-API routes
  if (req.path.startsWith('/api/')) {
    console.log(`❌ API route not found: ${req.path}`);
    res.status(404).json({
      success: false,
      error: `API endpoint not found: ${req.path}`,
      available_endpoints: [
        'GET /health',
        'GET /api/health', 
        'GET /api/companies',
        'GET /api/directory/:companyName',  // <- Added this
        'GET /api/members/:companyName',
        'POST /webhook/whop'
      ]
    });
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ==================== START SERVER ====================

app.listen(port, () => {
  console.log('');
  console.log('🎉 ===== SERVER STARTED =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log('');
  console.log('📋 API Endpoints:');
  console.log('   GET  /health                        - Health check');
  console.log('   GET  /api/companies                 - List all companies');
  console.log('   GET  /api/directory/:companyName    - Get members by company name (OLD)');
  console.log('   GET  /api/members/:companyName      - Get members by company name');
  console.log('   GET  /directory/:companyName        - Member directory page');
  console.log('   POST /webhook/whop                  - Whop webhook');
  console.log('');
  console.log('🔧 Debug:');
  console.log('   GET  /test.html                     - Debug/test page');
  console.log('');
});

module.exports = app;