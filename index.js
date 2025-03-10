const { getDBConnection } = require('./db');
const { authenticateToken } = require('./auth');
const {
  handleSignup,
  handleSignin,
  handleVerifyEmail,
  handleResendVerification,
  handleForgotPassword,
  handleResetPassword,
  handleViewPost,
  handleViewProfile,
  handleSearch,
  handleProxyImage,
  handleRefreshToken,
  handleGoogleSignin,
  handleEditProfile,
  handleNewPost,
  handleEditPost,
  handleDeletePost,
} = require('./handlers');

// Set a timeout function to guard against hanging operations
const withTimeout = (promise, timeoutMs = 15000, errorMessage = 'Operation timed out') => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      console.warn(`Operation timeout after ${timeoutMs}ms: ${errorMessage}`);
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  
  return Promise.race([
    promise,
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timeoutId);
  });
};

exports.handler = async (event) => {
  try {
    console.log("Lambda invoked with event:", JSON.stringify(event));
    
    // Log environment variables for debugging (excluding sensitive ones)
    console.log("Environment variables:", Object.keys(process.env)
      .filter(key => !key.includes('KEY') && !key.includes('SECRET') && !key.includes('PASSWORD'))
      .map(key => `${key}=${process.env[key] ? (key === 'SES_EMAIL_FROM' ? process.env[key] : '[SET]') : '[UNSET]'}`)
      .join(', '));
    
    // Check SES configuration
    if (!process.env.SES_EMAIL_FROM) {
      console.warn("WARNING: SES_EMAIL_FROM environment variable is not set. Email sending will fail.");
    }
    
    // Test internet connectivity
    try {
      console.log("Testing internet connectivity...");
      const https = require('https');
      const connectivityCheck = new Promise((resolve, reject) => {
        const req = https.get('https://www.google.com', (res) => {
          console.log(`Internet connectivity test successful: Status ${res.statusCode}`);
          // Consume response data to free up memory
          res.resume();
          resolve(true);
        });
        
        req.on('error', (e) => {
          console.error(`Internet connectivity test failed: ${e.message}`);
          resolve(false);
        });
        
        // Set a timeout of 2 seconds
        req.setTimeout(2000, () => {
          console.error('Internet connectivity test timed out');
          req.destroy();
          resolve(false);
        });
      });
      
      // Wait for connectivity test with a timeout
      await Promise.race([
        connectivityCheck,
        new Promise((_, reject) => setTimeout(() => {
          console.error('Connectivity test timeout (outer)');
          reject(new Error('Connectivity test outer timeout'));
        }, 2500))
      ]);
    } catch (connectError) {
      console.error(`Error testing connectivity: ${connectError.message}`);
    }
    
    // Test SES permissions
    try {
      console.log("Testing SES permissions...");
      const { SESClient, ListIdentitiesCommand } = require('@aws-sdk/client-ses');
      const sesClient = new SESClient();
      
      const permissionCheck = new Promise(async (resolve, reject) => {
        try {
          const listIdentitiesCommand = new ListIdentitiesCommand({
            IdentityType: 'EmailAddress',
            MaxItems: 10
          });
          
          const identitiesResponse = await sesClient.send(listIdentitiesCommand);
          console.log(`SES permissions test successful: Found ${identitiesResponse.Identities?.length || 0} verified identities`);
          if (identitiesResponse.Identities?.length > 0) {
            console.log(`Verified identities: ${identitiesResponse.Identities.join(', ')}`);
          }
          resolve(true);
        } catch (sesError) {
          console.error(`SES permissions test failed: ${sesError.message}`);
          if (sesError.Code) console.error(`SES error code: ${sesError.Code}`);
          resolve(false);
        }
      });
      
      // Wait for SES test with a timeout
      await Promise.race([
        permissionCheck,
        new Promise((_, reject) => setTimeout(() => {
          console.error('SES test outer timeout');
          reject(new Error('SES test timeout'));
        }, 2500))
      ]);
    } catch (sesTestError) {
      console.error(`Error testing SES permissions: ${sesTestError.message}`);
    }
    
    const { httpMethod, path } = event;

    // Handle CORS preflight requests - now handled by API Gateway
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'CORS preflight response' })
      };
    }

    console.log("Connecting to database...");
    let db;
    try {
      // Use withTimeout to prevent DB connection from hanging
      db = await withTimeout(
        getDBConnection(),
        8000, // Match our connection timeout
        "Database connection timed out - the database might be under heavy load or unreachable"
      );
      
      // Skip test query to save time in Lambda
      console.log("Database connection established - skipping test query for performance");
    } catch (dbError) {
      console.error("Database connection error:", dbError);
      
      // Check if this is a missing environment variable error
      if (dbError.message && dbError.message.includes("Missing required environment variables")) {
        return {
          statusCode: 500,
          body: JSON.stringify({ 
            error: "Lambda configuration error", 
            details: "The Lambda function is missing required database configuration environment variables",
            message: dbError.message
          })
        };
      }
      
      // Check if this is a timeout error
      if (dbError.message && (dbError.message.includes("timed out") || dbError.code === 'ETIMEDOUT')) {
        return {
          statusCode: 503, // Service Unavailable
          body: JSON.stringify({ 
            error: "Database service temporarily unavailable", 
            details: "The database connection attempt timed out. Please try again later.",
            code: dbError.code || "TIMEOUT"
          })
        };
      }
      
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: "Database connection failed", 
          details: dbError.message,
          code: dbError.code || "UNKNOWN"
        })
      };
    }

    let response;
    try {
      // Get handler based on route
      let handlerPromise;
      if (httpMethod === 'POST' && path === '/signup') {
        handlerPromise = handleSignup(event, db);
      } else if (httpMethod === 'POST' && path === '/signin') {
        handlerPromise = handleSignin(event, db);
      } else if (httpMethod === 'POST' && path === '/google-signin') {
        handlerPromise = handleGoogleSignin(event, db);
      } else if (httpMethod === 'GET' && path === '/verify-email') {
        console.log("Verify email endpoint called with path:", path);
        console.log("Query parameters:", JSON.stringify(event.queryStringParameters));
        console.log("Calling handleVerifyEmail handler");
        handlerPromise = handleVerifyEmail(event, db);
      } else if (httpMethod === 'POST' && path === '/resend-verification') {
        handlerPromise = handleResendVerification(event, db);
      } else if (httpMethod === 'POST' && path === '/forgot-password') {
        handlerPromise = handleForgotPassword(event, db);
      } else if (httpMethod === 'POST' && path === '/reset-password') {
        handlerPromise = handleResetPassword(event, db);
      } else if (httpMethod === 'GET' && path.startsWith('/viewpost/')) {
        handlerPromise = handleViewPost(event, db);
      } else if (httpMethod === 'GET' && path.startsWith('/viewprofile/')) {
        handlerPromise = handleViewProfile(event, db);
      } else if (httpMethod === 'GET' && path === '/search') {
        handlerPromise = handleSearch(event, db);
      } else if (httpMethod === 'GET' && path === '/proxy-image') {
        handlerPromise = handleProxyImage(event);
      } else {
        try {
          const user = await authenticateToken(event);
  
          if (httpMethod === 'POST' && path === '/refresh-token') {
            handlerPromise = handleRefreshToken(event, db);
          } else if (httpMethod === 'PUT' && path.startsWith('/editprofile/')) {
            handlerPromise = handleEditProfile(event, db, user);
          } else if (httpMethod === 'POST' && path.startsWith('/newpost/')) {
            handlerPromise = handleNewPost(event, db, user);
          } else if (httpMethod === 'PUT' && path.startsWith('/editpost/')) {
            handlerPromise = handleEditPost(event, db, user);
          } else if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) {
            handlerPromise = handleDeletePost(event, db, user);
          } else {
            response = { statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) };
          }
        } catch (authError) {
          console.error("Authentication error:", authError);
          response = { 
            statusCode: 401, 
            body: JSON.stringify({ 
              error: 'Authentication failed', 
              details: authError.message 
            }) 
          };
        }
      }

      // Execute handler with timeout if a valid handler was found
      if (handlerPromise && !response) {
        // Use longer timeout (14 seconds) for handler execution
        response = await withTimeout(
          handlerPromise,
          14000,
          "Handler operation timed out - the operation might be too resource-intensive for Lambda"
        );
      }
    } catch (handlerError) {
      console.error("Handler error:", handlerError);
      response = { 
        statusCode: 500, 
        body: JSON.stringify({ 
          error: 'Request processing error', 
          details: handlerError.message 
        }) 
      };
    }

    return response;
  } catch (error) {
    console.error("Lambda error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Server error',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};
