// YouTube Authentication Helper
const axios = require('axios');

// YouTube OAuth configuration
// In a production environment, these should be stored as environment variables
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://api-dev.quantifyjiujitsu.com/auth/youtube/callback';

/**
 * Get the YouTube OAuth URL for user authentication
 * @param {string} state - Optional state parameter to include in the OAuth flow (typically a token to identify the user)
 * @returns {string} The OAuth URL to redirect the user to
 */
const getYouTubeAuthUrl = (state = null) => {
    // Define the required scopes
    const scopes = [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube.upload'
    ].join(' ');

    // Build the OAuth URL
    let authUrl = 'https://accounts.google.com/o/oauth2/auth?' + 
        `client_id=${YOUTUBE_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(YOUTUBE_REDIRECT_URI)}` +
        `&scope=${encodeURIComponent(scopes)}` +
        '&response_type=code' +
        '&access_type=offline' +
        '&prompt=consent';
    
    // Add state parameter if provided
    if (state) {
        authUrl += `&state=${encodeURIComponent(state)}`;
    }

    return authUrl;
};

/**
 * Exchange an authorization code for OAuth tokens
 * @param {string} code The authorization code from the OAuth flow
 * @returns {Promise<Object>} The token response
 */
const exchangeCodeForTokens = async (code) => {
    try {
        console.log("YouTube Auth - Starting token exchange with code:", code.substring(0, 10) + "...");
        console.log("YouTube Auth - Using config:", {
            client_id_prefix: YOUTUBE_CLIENT_ID.substring(0, 8) + "...",
            redirect_uri: YOUTUBE_REDIRECT_URI,
            client_secret_set: !!YOUTUBE_CLIENT_SECRET
        });
        
        // This is important - Google requires form data for token exchange, not JSON
        const params = new URLSearchParams();
        params.append('code', code);
        params.append('client_id', YOUTUBE_CLIENT_ID);
        params.append('client_secret', YOUTUBE_CLIENT_SECRET);
        params.append('redirect_uri', YOUTUBE_REDIRECT_URI);
        params.append('grant_type', 'authorization_code');
        
        console.log("YouTube Auth - Sending token request to Google");
        
        const response = await axios.post(
            'https://oauth2.googleapis.com/token',
            params,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        console.log("YouTube Auth - Token exchange successful, received response:", {
            access_token_received: !!response.data.access_token,
            refresh_token_received: !!response.data.refresh_token,
            token_type: response.data.token_type,
            expires_in: response.data.expires_in
        });

        return response.data;
    } catch (error) {
        console.error('Error exchanging code for tokens:', error);
        if (error.response) {
            console.error('Response error data:', error.response.data);
            console.error('Response error status:', error.response.status);
        }
        throw error;
    }
};

/**
 * Save YouTube OAuth tokens to the database for a user
 * @param {Object} db - The database connection
 * @param {number} userId - The user ID
 * @param {Object} tokens - The token data (access_token, refresh_token, etc.)
 * @returns {Promise<Object>} - The saved token record
 */
const saveYouTubeTokens = async (db, userId, tokens) => {
    try {
        console.log(`Saving YouTube tokens for user ${userId}`);
        
        if (!db) {
            console.error('Database connection is null or undefined');
            throw new Error('Database connection is required');
        }
        
        // Calculate expiration time
        const expiresAt = tokens.expires_in 
            ? new Date(Date.now() + (tokens.expires_in * 1000)).toISOString()
            : null;
        
        try {
            // Check if user already has tokens
            const checkResult = await db.query(
                'SELECT id FROM youtube_tokens WHERE user_id = $1',
                [userId]
            );
            
            let result;
            
            if (checkResult.rows.length > 0) {
                // Update existing record
                result = await db.query(
                    `UPDATE youtube_tokens 
                    SET access_token = $1, 
                        refresh_token = COALESCE($2, refresh_token),
                        token_type = $3,
                        expires_at = $4,
                        updated_at = NOW()
                    WHERE user_id = $5
                    RETURNING *`,
                    [
                        tokens.access_token,
                        tokens.refresh_token || null,
                        tokens.token_type || 'Bearer',
                        expiresAt,
                        userId
                    ]
                );
            } else {
                // Create new record
                result = await db.query(
                    `INSERT INTO youtube_tokens 
                    (user_id, access_token, refresh_token, token_type, expires_at)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING *`,
                    [
                        userId,
                        tokens.access_token,
                        tokens.refresh_token || null,
                        tokens.token_type || 'Bearer',
                        expiresAt
                    ]
                );
            }
            
            console.log('YouTube tokens saved successfully');
            return result.rows[0];
        } catch (dbError) {
            console.error('Database operation failed:', dbError);
            throw dbError;
        }
    } catch (error) {
        console.error('Error saving YouTube tokens:', error);
        throw error;
    }
};

/**
 * Get YouTube OAuth tokens for a user
 * @param {Object} db - The database connection
 * @param {number} userId - The user ID
 * @returns {Promise<Object|null>} - The token data or null if not found
 */
const getYouTubeTokens = async (db, userId) => {
    try {
        console.log(`Getting YouTube tokens for user ${userId}`);
        
        if (!db) {
            console.error('Database connection is null or undefined');
            return null;
        }
        
        try {
            // Check if the table exists first
            const tableCheckResult = await db.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'youtube_tokens'
                )
            `);
            
            const tableExists = tableCheckResult.rows[0].exists;
            if (!tableExists) {
                console.log('YouTube tokens table does not exist yet');
                return null;
            }
            
            // Now safely query the table
            const result = await db.query(
                'SELECT * FROM youtube_tokens WHERE user_id = $1',
                [userId]
            );
            
            if (result.rows.length === 0) {
                console.log(`No YouTube tokens found for user ${userId}`);
                return null;
            }
            
            const tokenData = result.rows[0];
            
            // Check if token is expired
            if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
                console.log('Token is expired, needs refresh');
                
                // You would implement token refresh logic here using refresh_token
                // const refreshedTokens = await refreshYouTubeToken(tokenData.refresh_token);
                // await saveYouTubeTokens(db, userId, refreshedTokens);
                // return refreshedTokens;
                
                // For now, just return the expired token
                tokenData.is_expired = true;
            }
            
            return tokenData;
        } catch (dbError) {
            console.error('Database error getting YouTube tokens:', dbError);
            return null;
        }
    } catch (error) {
        console.error('Error getting YouTube tokens:', error);
        // Return null instead of throwing to prevent cascading errors
        return null;
    }
};

/**
 * Check if a user has valid YouTube OAuth tokens
 * @param {Object} db - The database connection
 * @param {number} userId - The user ID
 * @returns {Promise<boolean>} - True if tokens exist and are valid
 */
const hasValidYouTubeTokens = async (db, userId) => {
    try {
        if (!db) {
            console.error('Database connection is null or undefined');
            return false;
        }
        
        // getYouTubeTokens is already defensively coded
        const tokens = await getYouTubeTokens(db, userId);
        return tokens && !tokens.is_expired;
    } catch (error) {
        console.error('Error checking YouTube token validity:', error);
        return false;
    }
};

module.exports = {
    getYouTubeAuthUrl,
    exchangeCodeForTokens,
    saveYouTubeTokens,
    getYouTubeTokens,
    hasValidYouTubeTokens
};