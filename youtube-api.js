// YouTube API integration helper functions
const axios = require('axios');

// Mock YouTube credentials (for development only)
// In production, these would come from environment variables
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'your-youtube-api-key';
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || 'your-youtube-client-id';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || 'your-youtube-client-secret';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://quantifyjiujitsu.com/auth/youtube/callback';

/**
 * Get OAuth URL for YouTube authentication
 * @returns {string} The OAuth URL for user consent
 */
const getYouTubeAuthUrl = () => {
    const scopes = [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube.upload'
    ];
    
    return `https://accounts.google.com/o/oauth2/auth?client_id=${YOUTUBE_CLIENT_ID}&redirect_uri=${encodeURIComponent(YOUTUBE_REDIRECT_URI)}&scope=${encodeURIComponent(scopes.join(' '))}&response_type=code&access_type=offline&prompt=consent`;
};

/**
 * Exchange authorization code for access and refresh tokens
 * @param {string} code The authorization code from OAuth callback
 * @returns {Promise<Object>} The OAuth token response
 */
const exchangeCodeForTokens = async (code) => {
    try {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: YOUTUBE_CLIENT_ID,
            client_secret: YOUTUBE_CLIENT_SECRET,
            redirect_uri: YOUTUBE_REDIRECT_URI,
            grant_type: 'authorization_code'
        });
        
        return response.data;
    } catch (error) {
        console.error('Error exchanging code for tokens:', error);
        throw error;
    }
};

/**
 * Refresh an expired access token using refresh token
 * @param {string} refreshToken The refresh token from previous OAuth flow
 * @returns {Promise<Object>} The new OAuth token response
 */
const refreshAccessToken = async (refreshToken) => {
    try {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            refresh_token: refreshToken,
            client_id: YOUTUBE_CLIENT_ID,
            client_secret: YOUTUBE_CLIENT_SECRET,
            grant_type: 'refresh_token'
        });
        
        return response.data;
    } catch (error) {
        console.error('Error refreshing access token:', error);
        throw error;
    }
};

/**
 * Save YouTube credentials to the database
 * @param {Object} db Database connection object
 * @param {number} userId The user ID to associate credentials with
 * @param {Object} tokenData The OAuth token data
 * @returns {Promise<void>}
 */
const saveYouTubeCredentials = async (db, userId, tokenData) => {
    const { access_token, refresh_token, expires_in } = tokenData;
    
    // Calculate expiration timestamp
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expires_in);
    const expiresAtUtc = expiresAt.toISOString();
    
    try {
        // Get channel info
        const channelInfo = await getChannelInfo(access_token);
        
        // Insert or update credentials in database
        await db.execute(
            `INSERT INTO youtube_credentials 
             (user_id, access_token, refresh_token, expires_at, channel_id, channel_title, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET
             access_token = $2,
             refresh_token = $3,
             expires_at = $4,
             channel_id = $5,
             channel_title = $6,
             updated_at = CURRENT_TIMESTAMP`,
            [userId, access_token, refresh_token, expiresAtUtc, channelInfo.id, channelInfo.title]
        );
    } catch (error) {
        console.error('Error saving YouTube credentials:', error);
        throw error;
    }
};

/**
 * Get channel information for the authenticated user
 * @param {string} accessToken The OAuth access token
 * @returns {Promise<Object>} The channel information
 */
const getChannelInfo = async (accessToken) => {
    try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
            params: {
                part: 'snippet',
                mine: true
            },
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });
        
        if (response.data.items && response.data.items.length > 0) {
            const channel = response.data.items[0];
            return {
                id: channel.id,
                title: channel.snippet.title,
                description: channel.snippet.description,
                thumbnail: channel.snippet.thumbnails?.default?.url
            };
        }
        
        throw new Error('No channel found for this user');
    } catch (error) {
        console.error('Error getting channel info:', error);
        throw error;
    }
};

/**
 * Get videos from the user's YouTube channel
 * @param {string} accessToken The OAuth access token
 * @param {string} [pageToken] Optional page token for pagination
 * @returns {Promise<Object>} The channel videos response
 */
const getChannelVideos = async (accessToken, pageToken = '') => {
    try {
        // This would typically call the actual YouTube API
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                forMine: true,
                maxResults: 10,
                type: 'video',
                pageToken: pageToken || undefined,
                order: 'date'
            },
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });
        
        // Process videos to our format
        const videos = response.data.items.map(item => ({
            id: item.id.videoId,
            title: item.snippet.title,
            description: item.snippet.description,
            thumbnail: item.snippet.thumbnails.medium.url,
            publishedAt: new Date(item.snippet.publishedAt).toLocaleDateString()
        }));
        
        // To get duration, we'd need to make a separate API call
        // This would add complexity and API quota usage, so for simplicity
        // we're omitting it in this implementation
        
        return {
            videos,
            nextPageToken: response.data.nextPageToken,
            totalResults: response.data.pageInfo.totalResults
        };
    } catch (error) {
        console.error('Error getting channel videos:', error);
        
        // For development/testing, return mock data when API fails
        if (process.env.NODE_ENV === 'development') {
            console.log('Returning mock data for development');
            return getMockChannelVideos(pageToken);
        }
        
        throw error;
    }
};

/**
 * Get mock channel videos for development/testing
 * @param {string} [pageToken] Optional page token for pagination
 * @returns {Object} Mock channel videos response
 */
const getMockChannelVideos = (pageToken = '') => {
    // Generate mock video data
    const videos = Array(10).fill().map((_, i) => {
        const index = pageToken ? parseInt(pageToken) * 10 + i : i;
        return {
            id: `video-${index}`,
            title: `Sample YouTube Video ${index} - How to Execute the Perfect Triangle Choke`,
            description: `This is a sample description for video ${index}`,
            thumbnail: `https://picsum.photos/id/${index + 30}/320/180`,
            duration: `${Math.floor(Math.random() * 10) + 1}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}`,
            publishedAt: `${Math.floor(Math.random() * 12) + 1} months ago`
        };
    });
    
    return {
        videos,
        nextPageToken: pageToken ? (parseInt(pageToken) + 1).toString() : '1',
        totalResults: 50
    };
};

/**
 * Get YouTube credentials for a user from the database
 * @param {Object} db Database connection object
 * @param {number} userId The user ID to get credentials for
 * @returns {Promise<Object|null>} The credentials or null if not found
 */
const getUserYouTubeCredentials = async (db, userId) => {
    try {
        const [results] = await db.execute(
            'SELECT * FROM youtube_credentials WHERE user_id = $1',
            [userId]
        );
        
        if (results.length === 0) {
            return null;
        }
        
        return results[0];
    } catch (error) {
        console.error('Error getting YouTube credentials:', error);
        throw error;
    }
};

/**
 * Check if a user's YouTube access token is expired and refresh if needed
 * @param {Object} db Database connection object
 * @param {number} userId The user ID to check credentials for
 * @returns {Promise<string>} The valid access token
 */
const getValidAccessToken = async (db, userId) => {
    try {
        // Get current credentials
        const credentials = await getUserYouTubeCredentials(db, userId);
        
        if (!credentials) {
            throw new Error('No YouTube credentials found for this user');
        }
        
        // Check if token is expired
        const now = new Date();
        const expiresAt = new Date(credentials.expires_at);
        
        // If token is valid, return it
        if (expiresAt > now) {
            return credentials.access_token;
        }
        
        // Token is expired, refresh it
        const tokenData = await refreshAccessToken(credentials.refresh_token);
        
        // Calculate new expiration timestamp
        const newExpiresAt = new Date();
        newExpiresAt.setSeconds(newExpiresAt.getSeconds() + tokenData.expires_in);
        const newExpiresAtUtc = newExpiresAt.toISOString();
        
        // Update stored credentials
        await db.execute(
            `UPDATE youtube_credentials 
             SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $3`,
            [tokenData.access_token, newExpiresAtUtc, userId]
        );
        
        return tokenData.access_token;
    } catch (error) {
        console.error('Error getting valid access token:', error);
        throw error;
    }
};

module.exports = {
    getYouTubeAuthUrl,
    exchangeCodeForTokens,
    refreshAccessToken,
    saveYouTubeCredentials,
    getChannelInfo,
    getChannelVideos,
    getUserYouTubeCredentials,
    getValidAccessToken
};