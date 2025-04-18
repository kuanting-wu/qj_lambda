const { getDBConnection } = require('./db');
const { authenticateToken } = require('./auth');

const {
  handleProxyImage,
} = require('./image-handlers');

const {
  handleViewPost,
  handleSearchPosts,
  handleNewPost,
  handleEditPost,
  handleDeletePost,
  handleForkPost,
} = require('./post-handlers');

const {
  handleViewProfile,
  handleEditProfile,
} = require('./profiles-handlers');

const {
  handleSignup,
  handleSignin,
  handleVerifyEmail,
  handleResendVerification,
  handleForgotPassword,
  handleResetPassword,
  handleRefreshToken,
  handleGoogleSignin,
} = require('./auth-handlers');

const {
  handleYouTubeAuthUrl,
  handleYouTubeAuthCallback,
  handleYouTubeTokenCheck,
  handleYouTubeUploadInit,
} = require('./youtube-handlers');

const { handleUploadAvatar
} = require('./handle_upload_avatar');

const {
  handleNewGamePlan,
  handleSearchGamePlans,
  handleViewGamePlan,
  handleListGamePlansWithStatus,
  handleUpdateGamePlans,
  handleEditGamePlan,
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

      // Auth routes
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
      } else if (httpMethod === 'POST' && path === '/refresh-token') {
        handlerPromise = handleRefreshToken(event, db);
      }
      // Posts routes
      else if (httpMethod === 'GET' && path.startsWith('/viewpost/')) {
        handlerPromise = handleViewPost(event, db);
      } else if (httpMethod === 'GET' && path.startsWith('/viewprofile/')) {
        handlerPromise = handleViewProfile(event, db);
      } else if (httpMethod === 'GET' && path === '/search-posts') {
        handlerPromise = handleSearchPosts(event, db);
      }
      // Game Plan routes
      else if (httpMethod === 'GET' && path === '/search-gameplans') {
        handlerPromise = handleSearchGamePlans(event, db);
      } else if (httpMethod === 'GET' && path.startsWith('/view-gameplan/')) {
        handlerPromise = handleViewGamePlan(event, db);
      }
      // Proxy Image
      else if (httpMethod === 'GET' && path === '/proxy-image') {
        handlerPromise = handleProxyImage(event);
      }
      // YouTube OAuth route
      else if (httpMethod === 'GET' && path === '/auth/youtube/callback') {
        handlerPromise = handleYouTubeAuthCallback(event, db);
      }
      else {
        // Routes that require authentication
        try {
          const user = await authenticateToken(event);

          if (httpMethod === 'PUT' && path.startsWith('/editprofile/')) {
            handlerPromise = handleEditProfile(event, db, user);
          }
          // Game Plan
          else if (httpMethod === 'POST' && path === '/new-gameplan') {
            handlerPromise = handleNewGamePlan(event, db, user);
          } else if (httpMethod === 'GET' && path.startsWith('/list-gameplans/')) {
            handlerPromise = handleListGamePlansWithStatus(event, db, user);
          } else if (httpMethod === 'POST' && path.startsWith('/update-gameplans/')) {
            handlerPromise = handleUpdateGamePlans(event, db, user);
          } else if (httpMethod === 'PUT' && path.startsWith('/edit-gameplan/')) {
            handlerPromise = handleEditGamePlan(event, db, user);
          } else if (httpMethod === 'HEAD' && path.startsWith('/edit-gameplan/')) {
            handlerPromise = handleEditGamePlan(event, db, user);
          }
          // Posts
          else if (httpMethod === 'POST' && path === '/newpost') {
            handlerPromise = handleNewPost(event, db, user);
          } else if (httpMethod === 'PUT' && path.startsWith('/editpost/')) {
            handlerPromise = handleEditPost(event, db, user);
          } else if (httpMethod === 'HEAD' && path.startsWith('/editpost/')) {
            handlerPromise = handleEditPost(event, db, user);
          } else if (httpMethod === 'DELETE' && path.startsWith('/deletepost/')) {
            handlerPromise = handleDeletePost(event, db, user);
          } else if (httpMethod === 'POST' && path === '/fork-post') {
            handlerPromise = handleForkPost(event, db, user);
          }
          // Avatar
          else if (httpMethod === 'POST' && path === '/avatar') {
            handlerPromise = handleUploadAvatar(event, db, user);
          }
          // Youtube OAuth
          else if (httpMethod === 'GET' && path === '/youtube/auth') {
            handlerPromise = handleYouTubeAuthUrl(event, db, user);
          } else if (httpMethod === 'GET' && path === '/youtube/token-check') {
            handlerPromise = handleYouTubeTokenCheck(event, db, user);
          } else if (httpMethod === 'POST' && path === '/youtube/upload/init') {
            handlerPromise = handleYouTubeUploadInit(event, db, user);
          } else if (httpMethod === 'GET' && path === '/auth/youtube/callback') {
            handlerPromise = handleYouTubeAuthCallback(event, db, user);
          }
          else if (httpMethod === 'DELETE' && path.startsWith('/gameplans/') && !path.includes('/posts/')) {
            handlerPromise = deleteGamePlan(event, db);
          } else if (httpMethod === 'POST' && path.startsWith('/gameplans/') && !path.includes('/posts/')) {
            handlerPromise = addPostToGamePlan(event, db);
          } else if (httpMethod === 'DELETE' && path.match(/^\/gameplans\/[^\/]+\/posts\/[^\/]+$/)) {
            handlerPromise = removePostFromGamePlan(event, db);
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