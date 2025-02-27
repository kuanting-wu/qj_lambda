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
  handleEditProfile,
  handleNewPost,
  handleEditPost,
  handleDeletePost,
} = require('./handlers');

const addCorsHeaders = (response) => {
  return {
    ...response,
    headers: {
      ...response.headers,
      'Access-Control-Allow-Origin': 'http://localhost:8080',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  };
};

exports.handler = async (event) => {
  try {
    const { httpMethod, path } = event;
    const db = await getDBConnection();

    // Handle CORS preflight requests
    if (httpMethod === 'OPTIONS') {
      return addCorsHeaders({
        statusCode: 200,
        body: JSON.stringify({ message: 'CORS preflight response' }),
      });
    }

    let response;

    if (httpMethod === 'POST' && path === '/signup') response = await handleSignup(event, db);
    else if (httpMethod === 'POST' && path === '/signin') response = await handleSignin(event, db);
    else if (httpMethod === 'GET' && path === '/verify-email') response = await handleVerifyEmail(event, db);
    else if (httpMethod === 'POST' && path === '/forgot-password') response = await handleForgotPassword(event, db);
    else if (httpMethod === 'POST' && path === '/reset-password') response = await handleResetPassword(event, db);
    else if (httpMethod === 'GET' && path.startsWith('/viewpost/')) response = await handleViewPost(event, db);
    else if (httpMethod === 'GET' && path.startsWith('/viewprofile/')) response = await handleViewProfile(event, db);
    else if (httpMethod === 'GET' && path === '/search') response = await handleSearch(event, db);
    else if (httpMethod === 'GET' && path === '/proxy-image') response = await handleProxyImage(event);
    else {
      const user = await authenticateToken(event);

      if (httpMethod === 'POST' && path === '/refresh-token') response = await handleRefreshToken(event, db);
      else if (httpMethod === 'PUT' && path.startsWith('/editprofile/')) response = await handleEditProfile(event, db, user);
      else if (httpMethod === 'POST' && path.startsWith('/newpost/')) response = await handleNewPost(event, db, user);
      else if (httpMethod === 'PUT' && path.startsWith('/editpost/')) response = await handleEditPost(event, db, user);
      else if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) response = await handleDeletePost(event, db, user);
      else response = { statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) };
    }

    return addCorsHeaders(response);
  } catch (error) {
    return addCorsHeaders({
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    });
  }
};
