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

exports.handler = async (event) => {
  try {
    const { httpMethod, path } = event;
    const db = await getDBConnection();

    if (httpMethod === 'POST' && path === '/signup') return handleSignup(event, db);
    if (httpMethod === 'POST' && path === '/signin') return handleSignin(event, db);
    if (httpMethod === 'GET' && path === '/verify-email') return handleVerifyEmail(event, db);
    if (httpMethod === 'POST' && path === '/forgot-password') return handleForgotPassword(event, db);
    if (httpMethod === 'POST' && path === '/reset-password') return handleResetPassword(event, db);
    if (httpMethod === 'GET' && path.startsWith('/viewpost/')) return handleViewPost(event, db);
    if (httpMethod === 'GET' && path.startsWith('/viewprofile/')) return handleViewProfile(event, db);
    if (httpMethod === 'GET' && path === '/search') return handleSearch(event, db);
    if (httpMethod === 'GET' && path === '/proxy-image') return handleProxyImage(event);

    const user = await authenticateToken(event);

    if (httpMethod === 'POST' && path === '/refresh-token') return handleRefreshToken(event, db);
    if (httpMethod === 'PUT' && path.startsWith('/editprofile/')) return handleEditProfile(event, db, user);
    if (httpMethod === 'POST' && path.startsWith('/newpost/')) return handleNewPost(event, db, user);
    if (httpMethod === 'PUT' && path.startsWith('/editpost/')) return handleEditPost(event, db, user);
    if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) return handleDeletePost(event, db, user);

    return { statusCode: 404, body: JSON.stringify({ error: 'Route not found' }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
