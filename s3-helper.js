const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

// Initialize S3 client
const s3Client = new S3Client();

// Bucket name for markdown notes
const MARKDOWN_BUCKET = process.env.MARKDOWN_BUCKET || 'qj-markdown-notes';

// Upload markdown content to S3
const uploadMarkdownToS3 = async (content, postId, ownerId) => {
  if (!content) {
    throw new Error('No content provided for upload');
  }

  try {
    // Create a unique file path with owner ID and post ID
    // Using user ID instead of username for stability when username changes
    const key = `posts/user_${ownerId}/${postId}.md`;

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

// Get a pre-signed URL for a markdown file (for limited-time access)
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

// Delete a markdown file from S3
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

module.exports = {
  uploadMarkdownToS3,
  getMarkdownUrl,
  deleteMarkdownFromS3
};