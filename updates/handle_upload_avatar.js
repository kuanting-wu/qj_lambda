const { uploadAvatar, getPresignedUploadUrl, deleteAvatar } = require('../s3-avatar-helper');

/**
 * Handler for uploading and managing user avatars via S3
 * 
 * This handler supports three operations:
 * 1. Direct upload of avatar images (base64-encoded)
 * 2. Getting a pre-signed URL for client-side uploads 
 * 3. Deleting an existing avatar
 */
const handleUploadAvatar = async (event, db, user) => {
    console.log("Avatar upload handler called");
    console.log("Event path:", event.path);
    console.log("Event HTTP method:", event.httpMethod);
    console.log("Event path parameters:", event.pathParameters);
    console.log("Event request context:", event.requestContext?.authorizer);
    
    // Only authenticated users can upload avatars
    if (!user || !user.user_id) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Authentication required' })
        };
    }
    
    try {
        // Parse the request body for the operation data
        const requestBody = JSON.parse(event.body);
        const operation = requestBody.operation || 'upload';
        
        switch (operation) {
            case 'upload':
                return await handleDirectUpload(requestBody, db, user);
            
            case 'getUrl':
                return await handleGetPresignedUrl(requestBody, user);
            
            case 'delete':
                return await handleDeleteAvatar(requestBody, db, user);
            
            default:
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Invalid operation. Supported operations: upload, getUrl, delete' })
                };
        }
    } catch (error) {
        console.error('Error handling avatar operation:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Failed to process avatar request',
                message: error.message
            })
        };
    }
};

/**
 * Handle direct upload of base64-encoded avatar images
 */
const handleDirectUpload = async (requestBody, db, user) => {
    const { imageData, contentType } = requestBody;
    
    if (!imageData) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Image data is required' })
        };
    }
    
    try {
        // Decode base64 image
        const imageBuffer = Buffer.from(
            // Remove data URL prefix if present
            imageData.replace(/^data:image\/\w+;base64,/, ''),
            'base64'
        );
        
        // Make sure the image isn't too large (5MB max)
        const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
        if (imageBuffer.length > MAX_SIZE_BYTES) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Image too large. Maximum size is 5MB.' })
            };
        }
        
        // Process and upload the image
        const uploadResult = await uploadAvatar(
            imageBuffer, 
            user.user_id, 
            contentType || 'image/jpeg'
        );
        
        // Get the old avatar URL from the database
        const [profileResults] = await db.execute(
            'SELECT avatar_url FROM profiles WHERE user_id = $1',
            [user.user_id]
        );
        
        const oldAvatarUrl = profileResults.length > 0 ? profileResults[0].avatar_url : null;
        
        // Update the user's profile with the new avatar URL
        await db.execute(
            'UPDATE profiles SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
            [uploadResult.url, user.user_id]
        );
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Avatar uploaded successfully',
                avatarUrl: uploadResult.url,
                previousUrl: oldAvatarUrl
            })
        };
    } catch (error) {
        console.error('Error uploading avatar:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Failed to upload avatar',
                message: error.message
            })
        };
    }
};

/**
 * Handle generating a pre-signed URL for client-side uploads
 */
const handleGetPresignedUrl = async (requestBody, user) => {
    const { contentType = 'image/jpeg' } = requestBody;
    
    try {
        const result = await getPresignedUploadUrl(user.user_id, contentType);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Pre-signed URL generated successfully',
                uploadUrl: result.uploadUrl,
                key: result.key,
                // Instructions for the client
                instructions: {
                    method: 'PUT',
                    contentType: contentType,
                    expires: '5 minutes'
                }
            })
        };
    } catch (error) {
        console.error('Error generating pre-signed URL:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Failed to generate upload URL',
                message: error.message
            })
        };
    }
};

/**
 * Handle deleting an avatar
 */
const handleDeleteAvatar = async (requestBody, db, user) => {
    try {
        // Get the current avatar URL from the database
        const [profileResults] = await db.execute(
            'SELECT avatar_url FROM profiles WHERE user_id = $1',
            [user.user_id]
        );
        
        if (profileResults.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Profile not found' })
            };
        }
        
        const currentAvatarUrl = profileResults[0].avatar_url;
        
        // If there's no avatar to delete
        if (!currentAvatarUrl) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'No avatar to delete' })
            };
        }
        
        // Extract the key from the URL
        // Example: https://qj-user-avatars.s3.amazonaws.com/avatars/123/abc.webp
        const urlParts = currentAvatarUrl.split('/');
        const key = urlParts.slice(3).join('/'); // Skip the protocol and bucket parts
        
        // Delete the avatar from S3
        if (key) {
            await deleteAvatar(key);
        }
        
        // Set a default avatar URL or null based on your application's needs
        const defaultAvatarUrl = 'https://cdn.builder.io/api/v1/image/assets/TEMP/64c9bda73ca89162bc806ea1e084a3cd2dccf15193fe0e3c0e8008a485352e26?placeholderIfAbsent=true&apiKey=ee54480c62b34c3d9ff7ccdcccbf22d1';
        
        // Update the profile with the default avatar
        await db.execute(
            'UPDATE profiles SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
            [defaultAvatarUrl, user.user_id]
        );
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Avatar deleted successfully',
                defaultAvatarUrl: defaultAvatarUrl
            })
        };
    } catch (error) {
        console.error('Error deleting avatar:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Failed to delete avatar',
                message: error.message
            })
        };
    }
};

module.exports = handleUploadAvatar;