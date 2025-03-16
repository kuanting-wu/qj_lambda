// Handle YouTube Upload Initialization (Step 1 of the upload process)
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
    
    if (!fileSize || !mimeType) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'File size and MIME type are required' })
      };
    }
    
    // Get user's YouTube tokens from database
    const { 
      getYouTubeTokens, 
      hasValidYouTubeTokens 
    } = require('../youtube-auth');
    
    // Check if user has valid tokens
    const hasValidTokens = await hasValidYouTubeTokens(db, user.user_id);
    if (!hasValidTokens) {
      return {
        statusCode: 401,
        body: JSON.stringify({ 
          error: 'No valid YouTube tokens', 
          message: 'Please authenticate with YouTube first' 
        })
      };
    }
    
    // Get the tokens
    const tokens = await getYouTubeTokens(db, user.user_id);
    if (!tokens) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to retrieve YouTube tokens' })
      };
    }
    
    // Prepare metadata for the YouTube API
    const videoMetadata = {
      snippet: {
        title,
        description: description || `Uploaded via QuantifyJiuJitsu`,
        tags: Array.isArray(tags) ? tags : [tags],
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
            'X-Upload-Content-Length': fileSize,
            'X-Upload-Content-Type': mimeType
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
      
      // If we get an auth error, we should mark the token as expired
      if (youtubeError.response && (youtubeError.response.status === 401 || youtubeError.response.status === 403)) {
        console.log('Authentication error with YouTube API, marking token as expired');
        
        // In a production environment, we would refresh the token here
        // For now, we'll just return an error
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

module.exports = handleYouTubeUploadInit;