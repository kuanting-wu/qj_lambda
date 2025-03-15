// YouTube Authentication Helper
const axios = require('axios');

// YouTube OAuth configuration
// In a production environment, these should be stored as environment variables
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://api-dev.quantifyjiujitsu.com/auth/youtube/callback';

/**
 * Get the YouTube OAuth URL for user authentication
 * @returns {string} The OAuth URL to redirect the user to
 */
const getYouTubeAuthUrl = () => {
    // Define the required scopes
    const scopes = [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube.upload'
    ].join(' ');

    // Build the OAuth URL
    const authUrl = 'https://accounts.google.com/o/oauth2/auth?' + 
        `client_id=${YOUTUBE_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(YOUTUBE_REDIRECT_URI)}` +
        `&scope=${encodeURIComponent(scopes)}` +
        '&response_type=code' +
        '&access_type=offline' +
        '&prompt=consent';

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

module.exports = {
    getYouTubeAuthUrl,
    exchangeCodeForTokens
};