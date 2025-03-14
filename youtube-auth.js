// YouTube Authentication Helper
const axios = require('axios');

// YouTube OAuth configuration
// In a production environment, these should be stored as environment variables
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://quantifyjiujitsu.com/auth/youtube/callback';

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
        const response = await axios.post(
            'https://oauth2.googleapis.com/token',
            {
                code,
                client_id: YOUTUBE_CLIENT_ID,
                client_secret: YOUTUBE_CLIENT_SECRET,
                redirect_uri: YOUTUBE_REDIRECT_URI,
                grant_type: 'authorization_code'
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error exchanging code for tokens:', error);
        throw error;
    }
};

module.exports = {
    getYouTubeAuthUrl,
    exchangeCodeForTokens
};