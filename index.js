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
  handleSearchPosts,
  handleViewProfile,
  handleProxyImage,
  handleRefreshToken,
  handleGoogleSignin,
  handleEditProfile,
  handleNewPost,
  handleEditPost,
  handleDeletePost,
  handleYouTubeAuthUrl,
  handleYouTubeAuthCallback,
  handleYouTubeTokenCheck,
  handleYouTubeUploadInit,
} = require('./handlers');

const handleUploadAvatar = require('./handle_upload_avatar');

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

exports.handler = async (event) => {
  try {
    console.log("Lambda invoked with event:", JSON.stringify(event));
    // Get database connection - it's a singleton pattern so this is efficient
    let db;
    try {
      db = await withTimeout(getDBConnection(), 8000, 'Database connection timed out');
    } catch (error) {
      console.error("Database connection error:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Database connection failed", details: error.message })
      };
    }

    try {
      // Get handler based on route
      let handlerPromise;

      const { httpMethod, path } = event;

      // Public routes that don't require authentication
      if (httpMethod === 'POST' && path === '/signup') {
        handlerPromise = handleSignup(event, db);
      } else if (httpMethod === 'POST' && path === '/signin') {
        handlerPromise = handleSignin(event, db);
      } else if (httpMethod === 'POST' && path === '/google-signin') {
        handlerPromise = handleGoogleSignin(event, db);
      } else if (httpMethod === 'GET' && path === '/verify-email') {
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
      } else if (httpMethod === 'GET' && path === '/search-posts') {
        handlerPromise = handleSearchPosts(event, db);
      } else if (httpMethod === 'GET' && path === '/proxy-image') {
        handlerPromise = handleProxyImage(event);
      } else if (httpMethod === 'POST' && path === '/refresh-token') {
        // The refresh token endpoint should not require authentication
        handlerPromise = handleRefreshToken(event, db);
      } else if (httpMethod === 'GET' && path === '/auth/youtube/callback') {
        // YouTube OAuth callback should not require authentication
        handlerPromise = handleYouTubeAuthCallback(event, db);
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
          } else if (httpMethod === 'HEAD' && path.startsWith('/editpost/')) {
            handlerPromise = handleEditPost(event, db, user);
          } else if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) {
            handlerPromise = handleDeletePost(event, db, user);
          } else if (httpMethod === 'POST' && path === '/avatar') {
            handlerPromise = handleUploadAvatar(event, db, user);
          } else if (httpMethod === 'GET' && path === '/youtube/auth') {
            handlerPromise = handleYouTubeAuthUrl(event, db, user);
          } else if (httpMethod === 'GET' && path === '/youtube/token-check') {
            handlerPromise = handleYouTubeTokenCheck(event, db, user);
          } else if (httpMethod === 'POST' && path === '/youtube/upload/init') {
            handlerPromise = handleYouTubeUploadInit(event, db, user);
          } else if (httpMethod === 'GET' && path === '/auth/youtube/callback') {
            handlerPromise = handleYouTubeAuthCallback(event, db, user);
          }
          // Game Plan routes
          else if (httpMethod === 'GET' && path === '/search-gameplans') {
            handlerPromise = searchGamePlans(event, db);
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
            throw new Error('Route not found');
          }
        } catch (authError) {
          console.error("Authentication error:", authError);
          return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Authentication failed', details: authError.message || 'Invalid token' })
          };
        }
      }
      if (handlerPromise) {
        const result = await withTimeout(handlerPromise, 14500, `Handler for ${httpMethod} ${path} timed out`);
        return result;
      }

      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Route not found' })
      };

    } catch (error) {
      console.error("Error in request processing:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal server error', message: error.message })
      };
    }
  } catch (error) {
    console.error("Critical error in Lambda handler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
};