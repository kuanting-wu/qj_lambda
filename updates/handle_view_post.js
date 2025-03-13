// Updated handleViewPost function for owner_id
const handleViewPost = async (event, db) => {
    // Extract the post ID from the URL path
    const postId = event.pathParameters?.id;
    
    if (!postId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Post ID is required' }) };
    }
    
    try {
        // Join with profiles to get the owner information
        const query = `
            SELECT 
                p.*,
                pr.username as owner_name,
                pr.belt as owner_belt,
                pr.avatar_url as owner_avatar
            FROM 
                posts p
            JOIN 
                profiles pr ON p.owner_id = pr.user_id
            WHERE 
                p.id = $1
        `;
        
        const [results] = await db.execute(query, [postId]);
        
        if (results.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Post not found' }) };
        }
        
        const post = results[0];
        
        // If there's a markdown notes path, get the full URL
        if (post.notes_path) {
            try {
                // Get the URL for the markdown file
                const markdownUrl = await getMarkdownUrl(post.notes_path);
                post.markdown_url = markdownUrl;
            } catch (s3Error) {
                console.error('Error getting markdown URL:', s3Error);
                // Don't fail the whole request if S3 has an issue
                post.markdown_url = null;
                post.markdown_error = 'Unable to retrieve notes file';
            }
        }

        // Return the post data
        return {
            statusCode: 200,
            body: JSON.stringify(post), 
        };
    } catch (error) {
        console.error('Error fetching post:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch post' }) };
    }
};