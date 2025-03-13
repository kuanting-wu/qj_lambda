const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

// Initialize S3 client
const s3Client = new S3Client();

// Bucket names for storage
const MARKDOWN_BUCKET = process.env.MARKDOWN_BUCKET || 'qj-markdown-notes';
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'qj-user-avatars';

/**
 * Upload markdown content to S3
 * @param {string} content - The markdown content to upload
 * @param {string} postId - The ID of the post
 * @param {number|string} userId - The user ID of the post owner
 * @returns {Promise<string>} - The S3 key of the uploaded file
 */
const uploadMarkdownToS3 = async (content, postId, userId) => {
  if (!content) {
    throw new Error('No content provided for upload');
  }

  try {
    // Create a unique file path with owner user ID and post ID for stability
    const key = `posts/user_${userId}/${postId}.md`;

    // Upload the markdown file to S3
    const command = new PutObjectCommand({
      Bucket: MARKDOWN_BUCKET,
      Key: key,
      Body: content,
      ContentType: 'text/markdown',
      CacheControl: 'max-age=86400' // Cache for 24 hours
    });

    await s3Client.send(command);
    
    // Return the S3 file path/URL
    return key;
  } catch (error) {
    console.error('Error uploading markdown to S3:', error);
    throw new Error(`Failed to upload markdown: ${error.message}`);
  }
};

/**
 * Get a URL for a markdown file
 * @param {string} key - The S3 key of the markdown file
 * @returns {Promise<string>} - The URL of the markdown file
 */
const getMarkdownUrl = async (key) => {
  if (!key) {
    throw new Error('No file key provided');
  }

  try {
    // Construct the full S3 URL
    const s3Url = `https://${MARKDOWN_BUCKET}.s3.amazonaws.com/${key}`;
    return s3Url;
  } catch (error) {
    console.error('Error generating markdown URL:', error);
    throw new Error(`Failed to get markdown URL: ${error.message}`);
  }
};

/**
 * Delete a markdown file from S3
 * @param {string} key - The S3 key of the markdown file
 * @returns {Promise<boolean>} - True if the file was deleted successfully
 */
const deleteMarkdownFromS3 = async (key) => {
  if (!key) {
    throw new Error('No file key provided for deletion');
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: MARKDOWN_BUCKET,
      Key: key
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('Error deleting markdown from S3:', error);
    throw new Error(`Failed to delete markdown: ${error.message}`);
  }
};

/**
 * Upload an avatar image to S3
 * @param {Buffer} imageBuffer - The image data
 * @param {number|string} userId - The user ID
 * @param {string} filename - The filename to use
 * @returns {Promise<string>} - The S3 key of the uploaded file
 */
const uploadAvatarToS3 = async (imageBuffer, userId, filename) => {
  if (!imageBuffer) {
    throw new Error('No image data provided for upload');
  }

  try {
    // Create a unique file path with user ID
    const key = `avatars/user_${userId}/${filename}`;

    // Upload the avatar file to S3
    const command = new PutObjectCommand({
      Bucket: AVATAR_BUCKET,
      Key: key,
      Body: imageBuffer,
      ContentType: 'image/webp',
      CacheControl: 'max-age=31536000' // Cache for 1 year
    });

    await s3Client.send(command);
    
    // Return the S3 file path/URL
    return `https://${AVATAR_BUCKET}.s3.amazonaws.com/${key}`;
  } catch (error) {
    console.error('Error uploading avatar to S3:', error);
    throw new Error(`Failed to upload avatar: ${error.message}`);
  }
};

/**
 * Delete an avatar from S3
 * @param {string} key - The S3 key of the avatar
 * @returns {Promise<boolean>} - True if the file was deleted successfully
 */
const deleteAvatarFromS3 = async (key) => {
  if (!key) {
    throw new Error('No file key provided for deletion');
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: AVATAR_BUCKET,
      Key: key
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('Error deleting avatar from S3:', error);
    throw new Error(`Failed to delete avatar: ${error.message}`);
  }
};

module.exports = {
  uploadMarkdownToS3,
  getMarkdownUrl,
  deleteMarkdownFromS3,
  uploadAvatarToS3,
  deleteAvatarFromS3
};