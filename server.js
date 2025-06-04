// Updated server.js with proper authentication approach
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

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

// ==================== AUTHENTICATION MIDDLEWARE ====================

// Mock authentication - replace with real Whop auth
async function verifyWhopAuth(req) {
  // In a real app, this would:
  // 1. Verify JWT token from Whop
  // 2. Get user info from Whop API
  // 3. Return user details
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false, error: 'No valid auth token provided' };
  }
  
  // Mock user - replace with real Whop user data
  return {
    authorized: true,
    userId: 'user_123',
    username: 'testuser',
    email: 'test@example.com'
  };
}

async function verifyCompanyAccess(req, companyId) {
  // Verify user authentication
  const auth = await verifyWhopAuth(req);
  if (!auth.authorized) {
    return auth;
  }
  
  // In a real app, this would:
  // 1. Check if user is a member/admin of this company
  // 2. Query Whop API for user's company memberships
  // 3. Verify access level
  
  try {
    // Check if company exists in our database
    const companyResult = await pool.query(
      'SELECT company_id, company_name FROM whop_companies WHERE company_id = $1',
      [companyId]
    );
    
    if (companyResult.rows.length === 0) {
      return { 
        authorized: false, 
        error: 'Company not found',
        userMessage: 'The requested company does not exist.' 
      };
    }
    
    // Mock access check - replace with real permission verification
    return {
      authorized: true,
      userId: auth.userId,
      username: auth.username,
      email: auth.email,
      company: companyResult.rows[0],
      accessLevel: 'admin' // or 'member', 'viewer', etc.
    };
    
  } catch (error) {
    console.error('Error verifying company access:', error);
    return {
      authorized: false,
      error: 'Database error during authorization',
      userMessage: 'Unable to verify access permissions.'
    };
  }
}

// ==================== SECURE API ROUTES ====================

// Get user's accessible companies
app.get('/api/user/companies', async (req, res) => {
  try {
    const auth = await verifyWhopAuth(req);
    if (!auth.authorized) {
      return res.status(401).json({
        error: auth.userMessage || auth.error,
        code: 'UNAUTHORIZED'
      });
    }
    
    // In a real app, get companies from Whop API based on user's memberships
    // For now, return all companies (with member counts)
    const companiesResult = await pool.query(`
      SELECT 
        c.company_id,
        c.company_name,
        c.created_at,
        COUNT(m.id) as member_count
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id
      GROUP BY c.company_id, c.company_name, c.created_at
      ORDER BY c.company_name
    `);
    
    res.json({
      success: true,
      user: {
        id: auth.userId,
        username: auth.username,
        email: auth.email
      },
      companies: companiesResult.rows,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching user companies:', error);
    res.status(500).json({
      error: 'Failed to fetch companies',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Get members for a specific company (with authentication)
app.get('/api/companies/:companyId/members', async (req, res) => {
  try {
    const { companyId } = req.params;
    
    // Verify authentication and authorization
    const auth = await verifyCompanyAccess(req, companyId);
    if (!auth.authorized) {
      return res.status(401).json({
        error: auth.userMessage || auth.error,
        details: auth.error,
        code: 'UNAUTHORIZED'
      });
    }
    
    console.log(`✅ User ${auth.userId} accessing members for company ${companyId}`);
    
    // Get members for this company
    const membersResult = await pool.query(`
      SELECT 
        id, user_id, membership_id, email, name, username,
        custom_fields, joined_at, status, created_at, updated_at
      FROM whop_members 
      WHERE company_id = $1
      ORDER BY joined_at DESC NULLS LAST
    `, [companyId]);
    
    // Format members data
    const members = membersResult.rows.map(member => {
      let customFields = {};
      if (member.custom_fields) {
        try {
          customFields = typeof member.custom_fields === 'string' 
            ? JSON.parse(member.custom_fields) 
            : member.custom_fields;
        } catch (e) {
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
      company: auth.company,
      members: members,
      count: members.length,
      requestedBy: auth.userId,
      accessLevel: auth.accessLevel,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching company members:', error);
    res.status(500).json({
      error: 'Failed to fetch members',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Get company info (with authentication)
app.get('/api/companies/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    
    // Verify authentication and authorization
    const auth = await verifyCompanyAccess(req, companyId);
    if (!auth.authorized) {
      return res.status(401).json({
        error: auth.userMessage || auth.error,
        details: auth.error,
        code: 'UNAUTHORIZED'
      });
    }
    
    // Get company details with member stats
    const companyResult = await pool.query(`
      SELECT 
        c.company_id,
        c.company_name,
        c.created_at,
        c.updated_at,
        COUNT(m.id) as total_members,
        COUNT(CASE WHEN m.status = 'active' THEN 1 END) as active_members,
        COUNT(CASE WHEN m.joined_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_members_30d
      FROM whop_companies c
      LEFT JOIN whop_members m ON c.company_id = m.company_id
      WHERE c.company_id = $1
      GROUP BY c.company_id, c.company_name, c.created_at, c.updated_at
    `, [companyId]);
    
    if (companyResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Company not found',
        code: 'NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      company: companyResult.rows[0],
      requestedBy: auth.userId,
      accessLevel: auth.accessLevel,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching company info:', error);
    res.status(500).json({
      error: 'Failed to fetch company info',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is healthy!',
    timestamp: new Date().toISOString()
  });
});

// ==================== WEBHOOK (unchanged) ====================
app.post('/webhook/whop', async (req, res) => {
  // ... existing webhook code unchanged
});

// ==================== FRONTEND ROUTES ====================
app.get('/companies/:companyId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'secure-directory.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({
      error: `API endpoint not found: ${req.path}`,
      code: 'NOT_FOUND',
      availableEndpoints: [
        'GET /health',
        'GET /api/user/companies',
        'GET /api/companies/:companyId',
        'GET /api/companies/:companyId/members',
        'POST /webhook/whop'
      ]
    });
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(port, () => {
  console.log(`🚀 Secure server running on port ${port}`);
  console.log('🔐 Authentication-protected endpoints:');
  console.log('   GET  /api/user/companies           - Get user\'s accessible companies');
  console.log('   GET  /api/companies/:id            - Get company details'); 
  console.log('   GET  /api/companies/:id/members    - Get company members');
  console.log('   GET  /companies/:id                - Secure directory page');
});

module.exports = app;