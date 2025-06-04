// ==================== ULTRA SIMPLE SERVER.JS - COMPANY NAME TO ID LOOKUP ====================

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Starting Whop Member Directory Server...');

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
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

pool.connect()
  .then(client => {
    console.log('✅ Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  });

// ==================== API ROUTES ====================

// NEW: Resolve company name to company_id and get members
app.get('/api/directory/:companyName', async (req, res) => {
  const { companyName } = req.params;
  
  try {
    console.log(`🔍 Looking up company: ${companyName}`);
    
    // Step 1: Find company_id from company name (checking multiple possible column names)
    const companyResult = await pool.query(`
      SELECT company_id, name, title, route 
      FROM whop_companies 
      WHERE 
        name = $1 OR 
        title = $1 OR 
        route = $1 OR
        LOWER(name) = LOWER($1) OR
        LOWER(title) = LOWER($1) OR
        LOWER(route) = LOWER($1)
      LIMIT 1
    `, [companyName]);

    if (companyResult.rows.length === 0) {
      console.log(`❌ Company "${companyName}" not found`);
      
      // Debug: Show all companies
      const allCompanies = await pool.query('SELECT company_id, name, title, route FROM whop_companies LIMIT 10');
      console.log('📋 Available companies:', allCompanies.rows);
      
      return res.status(404).json({
        success: false,
        error: `Company "${companyName}" not found`,
        company_name: companyName,
        available_companies: allCompanies.rows
      });
    }

    const company = companyResult.rows[0];
    const companyId = company.company_id;
    
    console.log(`✅ Found company: ${companyName} -> ${companyId}`);

    // Step 2: Get all members for this company_id
    const membersResult = await pool.query(`
      SELECT 
        id, user_id, membership_id, email, name, username, 
        custom_fields, joined_at, status, created_at, updated_at
      FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC
    `, [companyId]);

    console.log(`✅ Found ${membersResult.rows.length} members for ${companyName}`);

    const members = membersResult.rows.map(member => {
      let parsedCustomFields = {};
      
      if (member.custom_fields) {
        try {
          if (typeof member.custom_fields === 'string') {
            parsedCustomFields = JSON.parse(member.custom_fields);
          } else {
            parsedCustomFields = member.custom_fields;
          }
        } catch (e) {
          parsedCustomFields = {};
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
      company_name: companyName,
      company_id: companyId,
      company_data: company,
      members: members,
      count: members.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in directory lookup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API is healthy!', 
    timestamp: new Date().toISOString()
  });
});

// ==================== WEBHOOK ENDPOINT (unchanged) ====================

app.post('/webhook/whop', async (req, res) => {
  try {
    console.log('🎯 Webhook received from Whop');
    
    const { data, event_type, action } = req.body;

    if (!data) {
      console.error('❌ No data provided in webhook');
      return res.status(400).json({ error: 'No data provided' });
    }

    // Extract company ID from webhook
    const companyId = 
      data.company_buyer_id ||
      data.page_id ||
      data.company_id ||
      data.business_id;
    
    if (!companyId) {
      console.error('❌ No company ID found in webhook data');
      return res.status(400).json({ error: 'No company ID found' });
    }

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

    // Prepare member data
    const email = data.email || null;
    const name = data.name || null;
    const username = data.username || null;
    const customFields = JSON.stringify(data.custom_field_responses || data.waitlist_responses || {});
    
    let joinedAt = new Date();
    if (data.created_at) {
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
        updated_at = NOW()
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
      error: error.message
    });
  }
});

// ==================== FRONTEND ROUTES ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================

app.listen(port, () => {
  console.log('');
  console.log('🎉 ===== SERVER STARTED SUCCESSFULLY =====');
  console.log(`🚀 Server running on port ${port}`);
  console.log('');
  console.log('🔧 Available API Endpoints:');
  console.log('   GET  /api/health                   - Health check');
  console.log('   GET  /api/directory/:companyName   - Get members by company name');
  console.log('   POST /webhook/whop                 - Whop webhook');
  console.log('');
});

module.exports = app;