const jwt = require('jsonwebtoken');

// Handle YouTube Auth URL
const handleYouTubeAuthUrl = async (event, db, user) => {
    const { getYouTubeAuthUrl, hasValidYouTubeTokens } = require('./youtube-auth');
    const { generateToken } = require('./auth');

    // Check authentication
    if (!user || !user.user_id) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'User not authenticated' })
        };
    }

    try {
        // Ensure database connection
        if (!db) {
            console.warn('Database connection is null, proceeding without token check');
            // Continue without token check - we want to allow auth
        } else {
            try {
                // Check if user already has valid tokens
                const hasTokens = await hasValidYouTubeTokens(db, user.user_id);

                if (hasTokens) {
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            alreadyAuthenticated: true,
                            message: 'User already has valid YouTube authentication'
                        })
                    };
                }
            } catch (tokenCheckError) {
                console.error('Error checking existing tokens, proceeding to auth:', tokenCheckError);
                // Continue to auth URL generation
            }
        }

        try {
            // Generate a short-lived token to include user_id in the state parameter
            // This will be passed back in the callback to identify the user
            const stateToken = generateToken({ userId: user.user_id }, '1h');

            // Get the auth URL with state parameter
            const authUrl = getYouTubeAuthUrl(stateToken);

            // Return the URL to the client
            return {
                statusCode: 200,
                body: JSON.stringify({
                    authUrl,
                    message: 'YouTube authentication URL generated successfully'
                })
            };
        } catch (authUrlError) {
            console.error('Error generating auth URL:', authUrlError);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to generate YouTube auth URL' })
            };
        }
    } catch (error) {
        console.error('Error in YouTube auth URL handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process YouTube auth request' })
        };
    }
};

// Handle YouTube token check - returns if the user has valid tokens
const handleYouTubeTokenCheck = async (event, db, user) => {
    const { hasValidYouTubeTokens, getYouTubeTokens } = require('./youtube-auth');

    // Check authentication
    if (!user || !user.user_id) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'User not authenticated' })
        };
    }

    try {
        // Check if the db connection is valid
        if (!db) {
            console.error('Database connection is null');
            return {
                statusCode: 200,
                body: JSON.stringify({
                    authenticated: false,
                    error: 'Database connection issue'
                })
            };
        }

        // Wrap everything in try/catch to return graceful errors instead of 500
        try {
            // Check if user has valid tokens
            const hasTokens = await hasValidYouTubeTokens(db, user.user_id);

            if (hasTokens) {
                // Get the token data
                const tokenData = await getYouTubeTokens(db, user.user_id);

                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        authenticated: true,
                        // Only return access token, not the refresh token
                        accessToken: tokenData.access_token,
                        expiresAt: tokenData.expires_at
                    })
                };
            } else {
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        authenticated: false
                    })
                };
            }
        } catch (innerError) {
            console.error('Error in YouTube token check inner operation:', innerError);
            // Return a 200 response with authentication false instead of a 500 error
            return {
                statusCode: 200,
                body: JSON.stringify({
                    authenticated: false,
                    message: 'Error checking token status'
                })
            };
        }
    } catch (error) {
        console.error('Error checking YouTube token status:', error);
        // Even for outer errors, return 200 with an error message
        return {
            statusCode: 200,
            body: JSON.stringify({
                authenticated: false,
                error: 'Failed to check YouTube token status'
            })
        };
    }
};

// Handle YouTube Auth Callback
const handleYouTubeAuthCallback = async (event, db) => {
    const { exchangeCodeForTokens, saveYouTubeTokens } = require('./youtube-auth');
    const { jwtDecode } = require('./auth');

    // Extract code from query parameters
    const { code, state } = event.queryStringParameters || {};

    console.log("YouTube Auth Callback received with code:", code ? `${code.substring(0, 10)}...` : 'none');
    console.log("Full event query params:", JSON.stringify(event.queryStringParameters));

    if (!code) {
        console.error("Missing authorization code in callback");
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Authorization code is required' })
        };
    }

    try {
        console.log("Exchanging code for tokens with YouTube API");
        // Exchange the code for tokens
        const tokenData = await exchangeCodeForTokens(code);
        console.log("Token exchange successful:", {
            access_token_preview: tokenData.access_token ? `${tokenData.access_token.substring(0, 10)}...` : 'none',
            token_type: tokenData.token_type,
            expires_in: tokenData.expires_in,
            refresh_token_received: !!tokenData.refresh_token
        });

        // If state contains a user token, extract the user ID and save the tokens to database
        let userId = null;
        if (state) {
            try {
                // The state should be the JWT token
                const decodedToken = jwtDecode(state);
                userId = decodedToken.userId;

                if (userId && db) {
                    console.log(`Saving YouTube tokens for user ID: ${userId}`);
                    try {
                        await saveYouTubeTokens(db, userId, tokenData);
                        console.log("YouTube tokens successfully saved to database");
                    } catch (saveError) {
                        console.error("Error saving YouTube tokens:", saveError);
                        // Continue even if token saving fails - we'll still return the tokens to client
                    }
                } else {
                    if (!userId) {
                        console.warn("No user ID found in state token");
                    }
                    if (!db) {
                        console.warn("No database connection available");
                    }
                }
            } catch (stateError) {
                console.error("Error decoding state parameter:", stateError);
                // Continue even if state parsing fails - we'll still return the tokens to client
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: 'YouTube authentication successful',
                // Only return access token, not the refresh token for security
                accessToken: tokenData.access_token,
                expiresIn: tokenData.expires_in,
                tokenType: tokenData.token_type,
                savedToDatabase: !!userId
            })
        };
    } catch (error) {
        console.error('Error in YouTube auth callback:', error);
        console.error('Error details:', error.response?.data || error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'YouTube authentication failed',
                details: error.message,
                errorData: error.response?.data || null
            })
        };
    }
};

const handleYouTubeUploadInit = async (event, db, user) => {
    try {
        // Parse request body for metadata
        const requestBody = JSON.parse(event.body);
        const {
            title,
            description,
            tags = [],
            privacyStatus = 'unlisted',
            categoryId = '22',
            fileSize,
            mimeType
        } = requestBody;

        // Validate necessary fields
        if (!title) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Title is required' })
            };
        }

        // Removed mandatory fileSize and mimeType validation
        // as we're now only requiring title, description, and privacyStatus

        // Get user's YouTube tokens from database
        const {
            getYouTubeTokens,
            hasValidYouTubeTokens
        } = require('./youtube-auth');

        // Get the tokens directly - our getYouTubeTokens function now handles refreshing
        const tokens = await getYouTubeTokens(db, user.user_id);

        // Check if tokens exist and aren't expired
        if (!tokens) {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    error: 'No YouTube tokens found',
                    message: 'Please authenticate with YouTube first'
                })
            };
        }

        // Check if tokens are expired and couldn't be refreshed
        if (tokens.is_expired) {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    error: 'YouTube tokens are expired and could not be refreshed',
                    message: 'Please re-authenticate with YouTube'
                })
            };
        }

        // Prepare metadata for the YouTube API
        const videoMetadata = {
            snippet: {
                title,
                description: description || `Uploaded via QuantifyJiuJitsu`,
                tags: Array.isArray(tags) ? tags : (tags ? [tags] : []),
                categoryId
            },
            status: {
                privacyStatus
            }
        };

        console.log('Initiating YouTube video upload with metadata:', {
            title,
            descriptionLength: description ? description.length : 0,
            tagCount: Array.isArray(tags) ? tags.length : 1,
            privacyStatus,
            categoryId,
            fileSize,
            mimeType
        });

        try {
            // Initialize a resumable upload with the YouTube API
            const axios = require('axios');

            // First request to initialize the upload and get the upload URL
            const initResponse = await axios.post(
                'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
                videoMetadata,
                {
                    headers: {
                        'Authorization': `Bearer ${tokens.access_token}`,
                        'Content-Type': 'application/json',
                        // Only include content length and type headers if they're provided
                        ...(fileSize ? { 'X-Upload-Content-Length': fileSize } : {}),
                        ...(mimeType ? { 'X-Upload-Content-Type': mimeType } : {})
                    }
                }
            );

            // Get the location header with the upload URL
            const uploadUrl = initResponse.headers.location;

            if (!uploadUrl) {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to get upload URL from YouTube' })
                };
            }

            console.log('Successfully initialized YouTube upload, received upload URL');
            console.log('Headers received from YouTube:', JSON.stringify(initResponse.headers));
            console.log('Upload URL:', uploadUrl);

            // Return the upload URL to the client to complete the upload directly
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Upload initialized successfully',
                    uploadUrl,
                    debug: {
                        requestId: Math.random().toString(36).substring(2, 12),
                        timestamp: new Date().toISOString()
                    }
                })
            };

        } catch (youtubeError) {
            console.error('Error initializing YouTube upload:', youtubeError);

            // If we get an auth error, try to handle it appropriately
            if (youtubeError.response && (youtubeError.response.status === 401 || youtubeError.response.status === 403)) {
                console.log('Authentication error with YouTube API:', youtubeError.response.status);

                // We've already tried to refresh tokens when getting them earlier, 
                // but in case the token expired just after that, try again
                try {
                    const { refreshYouTubeToken, saveYouTubeTokens } = require('./youtube-auth');

                    // Check if we have a refresh token
                    if (tokens.refresh_token) {
                        console.log('Attempting to refresh token after API auth error');

                        // Refresh the token
                        const refreshedTokens = await refreshYouTubeToken(tokens.refresh_token);

                        // Save the refreshed tokens
                        await saveYouTubeTokens(db, user.user_id, refreshedTokens);

                        // Let the user know to try again
                        return {
                            statusCode: 401,
                            body: JSON.stringify({
                                error: 'Token refreshed, please try again',
                                message: 'Your YouTube token has been refreshed. Please try your upload again.'
                            })
                        };
                    }
                } catch (refreshError) {
                    console.error('Failed to refresh token after API auth error:', refreshError);
                }

                // If we reach here, we couldn't refresh the token
                return {
                    statusCode: 401,
                    body: JSON.stringify({
                        error: 'YouTube authentication error',
                        message: 'Your YouTube authorization has expired. Please reconnect your account.'
                    })
                };
            }

            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'YouTube API error',
                    message: youtubeError.response?.data?.error?.message || youtubeError.message
                })
            };
        }

    } catch (error) {
        console.error('Error handling YouTube upload initialization:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Server error processing YouTube upload',
                message: error.message
            })
        };
    }
};

module.exports = {
    handleYouTubeAuthUrl,
    handleYouTubeAuthCallback,
    handleYouTubeTokenCheck,
    handleYouTubeUploadInit,
  };