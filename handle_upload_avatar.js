const { uploadAvatar, getPresignedUploadUrl, deleteAvatar } = require('./s3-avatar-helper');

/**
 * Helper function to add CORS headers to responses
 */
const addCorsHeaders = (response, event) => {
    const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:8080';

    // Define allowed origins
    const allowedOrigins = [
        'http://localhost:8080',
        'http://localhost:8081',
        'http://localhost:3000',
        'https://quantifyjiujitsu.com',
        'https://www.quantifyjiujitsu.com',
        'https://dev.quantifyjiujitsu.com',
        'https://staging.quantifyjiujitsu.com',
        'https://api-dev.quantifyjiujitsu.com',
        'https://api.quantifyjiujitsu.com',
        'https://api-staging.quantifyjiujitsu.com'
    ];

    // Use the origin if it's in the allowed list, otherwise use a default
    const responseOrigin = allowedOrigins.includes(origin) ? origin : 'https://quantifyjiujitsu.com';

    return {
        ...response,
        headers: {
            ...response.headers,
            'Access-Control-Allow-Origin': responseOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Amz-Date, X-Amz-Security-Token, Accept, Origin, Referer, User-Agent',
            'Access-Control-Allow-Credentials': 'true'
        }
    };
};

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
        return addCorsHeaders({
            statusCode: 401,
            body: JSON.stringify({ error: 'Authentication required' })
        }, event);
    }

    try {
        // Parse the request body for the operation data
        const requestBody = JSON.parse(event.body);
        const operation = requestBody.operation || 'upload';

        switch (operation) {
            case 'upload':
                return await handleDirectUpload(requestBody, db, user, event);

            case 'getUrl':
                return await handleGetPresignedUrl(requestBody, user, event);

            case 'delete':
                return await handleDeleteAvatar(requestBody, db, user, event);

            default:
                return addCorsHeaders({
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Invalid operation. Supported operations: upload, getUrl, delete' })
                }, event);
        }
    } catch (error) {
        console.error('Error handling avatar operation:', error);
        return addCorsHeaders({
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to process avatar request',
                message: error.message
            })
        }, event);
    }
};

/**
 * Handle direct upload of base64-encoded avatar images
 */
const handleDirectUpload = async (requestBody, db, user, event) => {
    const { imageData, contentType } = requestBody;

    if (!imageData) {
        return addCorsHeaders({
            statusCode: 400,
            body: JSON.stringify({ error: 'Image data is required' })
        }, event);
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
            return addCorsHeaders({
                statusCode: 400,
                body: JSON.stringify({ error: 'Image too large. Maximum size is 5MB.' })
            }, event);
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

        // Generate new tokens that include the avatar URL
        const { generateAccessToken, generateRefreshToken } = require('./auth');

        // Generate new tokens with the updated avatar URL
        const accessToken = generateAccessToken({
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            avatar_url: uploadResult.url
        });

        const refreshToken = generateRefreshToken({
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            avatar_url: uploadResult.url
        });

        return addCorsHeaders({
            statusCode: 200,
            body: JSON.stringify({
                message: 'Avatar uploaded successfully',
                avatarUrl: uploadResult.url,
                previousUrl: oldAvatarUrl,
                accessToken,
                refreshToken
            })
        }, event);
    } catch (error) {
        console.error('Error uploading avatar:', error);
        return addCorsHeaders({
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to upload avatar',
                message: error.message
            })
        }, event);
    }
};

/**
 * Handle generating a pre-signed URL for client-side uploads
 */
const handleGetPresignedUrl = async (requestBody, user, event) => {
    const { contentType = 'image/jpeg' } = requestBody;

    try {
        const result = await getPresignedUploadUrl(user.user_id, contentType);

        return addCorsHeaders({
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
        }, event);
    } catch (error) {
        console.error('Error generating pre-signed URL:', error);
        return addCorsHeaders({
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to generate upload URL',
                message: error.message
            })
        }, event);
    }
};

/**
 * Handle deleting an avatar
 */
const handleDeleteAvatar = async (requestBody, db, user, event) => {
    try {
        // Get the current avatar URL from the database
        const [profileResults] = await db.execute(
            'SELECT avatar_url FROM profiles WHERE user_id = $1',
            [user.user_id]
        );

        if (profileResults.length === 0) {
            return addCorsHeaders({
                statusCode: 404,
                body: JSON.stringify({ error: 'Profile not found' })
            }, event);
        }

        const currentAvatarUrl = profileResults[0].avatar_url;

        // If there's no avatar to delete
        if (!currentAvatarUrl) {
            return addCorsHeaders({
                statusCode: 400,
                body: JSON.stringify({ error: 'No avatar to delete' })
            }, event);
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

        // Generate new tokens that include the default avatar URL
        const { generateAccessToken, generateRefreshToken } = require('./auth');

        // Generate new tokens with the updated avatar URL
        const accessToken = generateAccessToken({
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            avatar_url: defaultAvatarUrl
        });

        const refreshToken = generateRefreshToken({
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            avatar_url: defaultAvatarUrl
        });

        return addCorsHeaders({
            statusCode: 200,
            body: JSON.stringify({
                message: 'Avatar deleted successfully',
                defaultAvatarUrl: defaultAvatarUrl,
                accessToken,
                refreshToken
            })
        }, event);
    } catch (error) {
        console.error('Error deleting avatar:', error);
        return addCorsHeaders({
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to delete avatar',
                message: error.message
            })
        }, event);
    }
};

module.exports = {
    handleUploadAvatar
};
