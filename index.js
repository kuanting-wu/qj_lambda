const { getDBConnection } = require('./db');
const { authenticateToken } = require('./auth');
const {
  handleSignup,
  handleSignin,
  handleVerifyEmail,
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

exports.handler = async (event) => {
  try {
    console.log("Lambda invoked with event:", JSON.stringify(event));
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
      db = await getDBConnection();
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
      if (httpMethod === 'POST' && path === '/signup') response = await handleSignup(event, db);
      else if (httpMethod === 'POST' && path === '/signin') response = await handleSignin(event, db);
      else if (httpMethod === 'POST' && path === '/google-signin') response = await handleGoogleSignin(event, db);
      else if (httpMethod === 'GET' && path === '/verify-email') response = await handleVerifyEmail(event, db);
      else if (httpMethod === 'POST' && path === '/forgot-password') response = await handleForgotPassword(event, db);
      else if (httpMethod === 'POST' && path === '/reset-password') response = await handleResetPassword(event, db);
      else if (httpMethod === 'GET' && path.startsWith('/viewpost/')) response = await handleViewPost(event, db);
      else if (httpMethod === 'GET' && path.startsWith('/viewprofile/')) response = await handleViewProfile(event, db);
      else if (httpMethod === 'GET' && path === '/search') response = await handleSearch(event, db);
      else if (httpMethod === 'GET' && path === '/proxy-image') response = await handleProxyImage(event);
      else {
        try {
          const user = await authenticateToken(event);
  
          if (httpMethod === 'POST' && path === '/refresh-token') response = await handleRefreshToken(event, db);
          else if (httpMethod === 'PUT' && path.startsWith('/editprofile/')) response = await handleEditProfile(event, db, user);
          else if (httpMethod === 'POST' && path.startsWith('/newpost/')) response = await handleNewPost(event, db, user);
          else if (httpMethod === 'PUT' && path.startsWith('/editpost/')) response = await handleEditPost(event, db, user);
          else if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) response = await handleDeletePost(event, db, user);
          else response = { statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) };
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
