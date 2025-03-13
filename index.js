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

// Import the avatar upload handler
const handleUploadAvatar = require('./updates/handle_upload_avatar');

const {
  createGamePlan,
  getGamePlans,
  getGamePlanById,
  updateGamePlan,
  deleteGamePlan,
  addPostToGamePlan,
  removePostFromGamePlan,
  getPostsByPosition,
  getPostsByTransition,
  getAllPositions
} = require('./game-plan-handlers');

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

// Utility function to add CORS headers to all responses
const addCorsHeaders = (response, event) => {
  // Get the origin from the request headers
  const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:8080';

  // List of allowed origins to match API Gateway config
  const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:3000',
    'https://quantifyjiujitsu.com',
    'https://www.quantifyjiujitsu.com',
    'https://dev.quantifyjiujitsu.com',
    'https://staging.quantifyjiujitsu.com',
    'https://api-dev.quantifyjiujitsu.com',
    'https://api.quantifyjiujitsu.com',
    'https://api-staging.quantifyjiujitsu.com'
  ];

  // Set appropriate origin - if the request origin is allowed, use it; otherwise use a default
  const responseOrigin = allowedOrigins.includes(origin) ? origin : 'https://quantifyjiujitsu.com';

  // Add CORS headers to the response
  return {
    ...response,
    headers: {
      ...response.headers,
      "Access-Control-Allow-Origin": responseOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Amz-Date, X-Amz-Security-Token, Accept, Origin, Referer, User-Agent",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400"
    }
  };
};

exports.handler = async (event) => {
  try {
    console.log("Lambda invoked with event:", JSON.stringify(event));
    
    // Log environment variables for debugging (excluding sensitive ones)
    console.log("Environment variables:", Object.keys(process.env)
      .filter(key => !key.includes('KEY') && !key.includes('SECRET') && !key.includes('PASSWORD'))
      .map(key => `${key}=${process.env[key] ? (key === 'SES_EMAIL_FROM' ? process.env[key] : '[SET]') : '[UNSET]'}`));
    
    // Get database connection - it's a singleton pattern so this is efficient
    let db;
    try {
      db = await withTimeout(getDBConnection(), 8000, 'Database connection timed out');
      console.log("Database connection established successfully");
    } catch (dbError) {
      console.error("Database connection error:", dbError);
      return addCorsHeaders({
        statusCode: 500,
        body: JSON.stringify({ 
          error: "Database connection failed", 
          details: dbError.message,
          code: dbError.code || "UNKNOWN"
        })
      }, event);
    }

    let response;
    try {
      // Get handler based on route
      let handlerPromise;
      
      const { httpMethod, path } = event;

      // Handle CORS preflight requests - must return proper CORS headers
      if (httpMethod === 'OPTIONS') {
        const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:8080';
        const allowedOrigins = [
          'http://localhost:8080',
          'http://localhost:8081',
          'http://localhost:3000',
          'https://quantifyjiujitsu.com',
          'https://www.quantifyjiujitsu.com',
          'https://dev.quantifyjiujitsu.com',
          'https://staging.quantifyjiujitsu.com',
          'https://api-dev.quantifyjiujitsu.com',
          'https://api.quantifyjiujitsu.com',
          'https://api-staging.quantifyjiujitsu.com'
        ];
        const responseOrigin = allowedOrigins.includes(origin) ? origin : 'https://quantifyjiujitsu.com';
        
        return {
          statusCode: 204, // No content is more appropriate for OPTIONS
          headers: {
            "Access-Control-Allow-Origin": responseOrigin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Amz-Date, X-Amz-Security-Token, Accept, Origin, Referer, User-Agent",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age": "86400"
          },
          body: "" // Empty body for OPTIONS response
        };
      }
      
      // Public routes that don't require authentication
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
      } else if (httpMethod === 'POST' && path === '/refresh-token') {
        // The refresh token endpoint should not require authentication
        handlerPromise = handleRefreshToken(event, db);
      } else {
        // Routes that require authentication
        try {
          const user = await authenticateToken(event);
          
          if (httpMethod === 'PUT' && path.startsWith('/editprofile/')) {
            handlerPromise = handleEditProfile(event, db, user);
          } else if (httpMethod === 'POST' && path === '/newpost') {
            handlerPromise = handleNewPost(event, db, user);
          } else if (httpMethod === 'PUT' && path.startsWith('/editpost/')) {
            handlerPromise = handleEditPost(event, db, user);
          } else if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) {
            handlerPromise = handleDeletePost(event, db, user);
          } else if (httpMethod === 'POST' && path === '/avatar') {
            handlerPromise = handleUploadAvatar(event, db, user);
          } 
          // Game Plan routes
          else if (httpMethod === 'GET' && path === '/gameplans') {
            handlerPromise = getGamePlans(event, db);
          } else if (httpMethod === 'POST' && path === '/gameplans') {
            handlerPromise = createGamePlan(event, db);
          } else if (httpMethod === 'GET' && path.startsWith('/gameplans/') && !path.includes('/posts/')) {
            handlerPromise = getGamePlanById(event, db);
          } else if (httpMethod === 'PUT' && path.startsWith('/gameplans/') && !path.includes('/posts/')) {
            handlerPromise = updateGamePlan(event, db);
          } else if (httpMethod === 'DELETE' && path.startsWith('/gameplans/') && !path.includes('/posts/')) {
            handlerPromise = deleteGamePlan(event, db);
          } else if (httpMethod === 'POST' && path.startsWith('/gameplans/') && !path.includes('/posts/')) {
            handlerPromise = addPostToGamePlan(event, db);
          } else if (httpMethod === 'DELETE' && path.match(/^\/gameplans\/[^\/]+\/posts\/[^\/]+$/)) {
            handlerPromise = removePostFromGamePlan(event, db);
          } else if (httpMethod === 'GET' && path.startsWith('/gameplans/') && path.includes('/positions')) {
            handlerPromise = getPostsByPosition(event, db);
          } else if (httpMethod === 'GET' && path.startsWith('/gameplans/') && path.includes('/transitions')) {
            handlerPromise = getPostsByTransition(event, db);
          } else if (httpMethod === 'GET' && path === '/positions') {
            handlerPromise = getAllPositions(event, db);
          } else {
            response = addCorsHeaders({ statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) }, event);
          }
        } catch (authError) {
          console.error("Authentication error:", authError);
          response = addCorsHeaders({ 
            statusCode: 401, 
            body: JSON.stringify({ 
              error: 'Authentication failed', 
              details: authError.message || 'Access token missing or invalid' 
            }) 
          }, event);
        }
      }

      // If a handler was selected, execute it with timeout protection
      if (handlerPromise) {
        const timeoutPromise = withTimeout(
          handlerPromise, 
          14500, // Just under Lambda's 15s timeout to ensure we have time to add CORS headers
          `Handler for ${httpMethod} ${path} timed out`
        );
        
        const result = await timeoutPromise;
        response = addCorsHeaders(result, event);
      }
    } catch (error) {
      console.error("Error in request processing:", error);
      response = addCorsHeaders({
        statusCode: 500,
        body: JSON.stringify({ 
          error: "Internal server error", 
          message: error.message,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        })
      }, event);
    }

    return response;
  } catch (error) {
    console.error("Critical error in Lambda handler:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key"
      },
      body: JSON.stringify({ 
        error: "Critical Lambda handler error", 
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};