const AWS = require('aws-sdk');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

// Initialize S3 client
const s3 = new AWS.S3();
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'qj-user-avatars';
const MAX_SIZE = 500; // Maximum dimension (width or height) in pixels

/**
 * Process and upload avatar image to S3
 * This function will:
 * 1. Resize image to appropriate dimensions (max 500x500px)
 * 2. Convert to webp format for better compression
 * 3. Upload to S3 with a unique filename
 * 
 * @param {Buffer} imageBuffer - The raw image buffer
 * @param {string} userId - The user's ID to associate with the avatar
 * @param {string} contentType - The MIME type of the uploaded image
 * @returns {Promise<Object>} - The upload result, including the URL
 */
const uploadAvatar = async (imageBuffer, userId, contentType) => {
    // Validate input
    if (!imageBuffer || !userId) {
        throw new Error('Image buffer and userId are required');
    }
    
    try {
        console.log(`Processing avatar image for user ${userId}, content type: ${contentType}, size: ${imageBuffer.length} bytes`);
        
        // Validate image is actually an image
        if (!contentType || !contentType.startsWith('image/')) {
            throw new Error('Invalid file type. Only images are allowed.');
        }
        
        // Generate a unique filename with the user ID
        const filename = `avatars/${userId}/${uuidv4()}.webp`;
        
        // Process the image with sharp
        const processedImageBuffer = await sharp(imageBuffer)
            // Resize, keeping aspect ratio, only if the image is larger than MAX_SIZE
            .resize(MAX_SIZE, MAX_SIZE, {
                fit: 'inside',
                withoutEnlargement: true
            })
            // Convert to webp format for better compression
            .webp({ quality: 80 })
            .toBuffer();
        
        console.log(`Image processed successfully. Original size: ${imageBuffer.length} bytes, New size: ${processedImageBuffer.length} bytes`);
        
        // Upload to S3
        const uploadParams = {
            Bucket: AVATAR_BUCKET,
            Key: filename,
            Body: processedImageBuffer,
            ContentType: 'image/webp',
            CacheControl: 'max-age=31536000' // Cache for 1 year
        };
        
        const uploadResult = await s3.upload(uploadParams).promise();
        console.log(`Avatar uploaded successfully to ${uploadResult.Location}`);
        
        return {
            success: true,
            url: uploadResult.Location,
            key: filename
        };
    } catch (error) {
        console.error('Error processing or uploading avatar:', error);
        throw error;
    }
};

/**
 * Delete an avatar from S3
 * @param {string} avatarKey - The S3 key of the avatar to delete
 * @returns {Promise<Object>} - The deletion result
 */
const deleteAvatar = async (avatarKey) => {
    if (!avatarKey) {
        throw new Error('Avatar key is required');
    }
    
    try {
        console.log(`Deleting avatar with key: ${avatarKey}`);
        
        const deleteParams = {
            Bucket: AVATAR_BUCKET,
            Key: avatarKey
        };
        
        await s3.deleteObject(deleteParams).promise();
        console.log(`Avatar deleted successfully: ${avatarKey}`);
        
        return {
            success: true,
            message: 'Avatar deleted successfully'
        };
    } catch (error) {
        console.error('Error deleting avatar:', error);
        throw error;
    }
};

/**
 * Generate a pre-signed URL for client-side uploads
 * @param {string} userId - The user's ID 
 * @param {string} contentType - The MIME type of the file to be uploaded
 * @returns {Promise<Object>} - Object containing the pre-signed URL
 */
const getPresignedUploadUrl = async (userId, contentType) => {
    if (!userId || !contentType) {
        throw new Error('userId and contentType are required');
    }
    
    try {
        // Generate a unique key for the file
        const key = `avatars/${userId}/${uuidv4()}.${contentType.split('/')[1] || 'jpg'}`;
        
        const params = {
            Bucket: AVATAR_BUCKET,
            Key: key,
            ContentType: contentType,
            Expires: 300 // URL expires in 5 minutes
        };
        
        const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
        
        return {
            success: true,
            uploadUrl,
            key
        };
    } catch (error) {
        console.error('Error generating pre-signed URL:', error);
        throw error;
    }
};

module.exports = {
    uploadAvatar,
    deleteAvatar,
    getPresignedUploadUrl
};