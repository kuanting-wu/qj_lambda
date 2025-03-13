// Updated handleDeletePost function that uses owner_id
const handleDeletePost = async (event, db, user) => {
    console.log("Delete post handler called by user:", user.username, user.user_id);
    
    const postId = event.pathParameters?.id;
    if (!postId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Post ID is required" })
        };
    }
    
    try {
        // First get the post to check ownership and get notes_path if exists
        const [posts] = await db.execute(
            'SELECT * FROM posts WHERE id = $1',
            [postId]
        );
        
        if (posts.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Post not found" })
            };
        }
        
        const post = posts[0];
        
        // Check if user owns the post by comparing user_id
        if (post.owner_id !== user.user_id) {
            console.warn(`User ${user.user_id} attempted to delete post ${postId} owned by ${post.owner_id}`);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: "You do not have permission to delete this post" })
            };
        }
        
        // If post has notes, delete them from S3
        if (post.notes_path) {
            try {
                await deleteMarkdown(post.notes_path);
                console.log(`Deleted markdown file: ${post.notes_path}`);
            } catch (s3Error) {
                console.error(`Error deleting markdown file: ${post.notes_path}`, s3Error);
                // Continue with post deletion even if S3 deletion fails
            }
        }
        
        // Delete the post
        await db.execute(
            'DELETE FROM posts WHERE id = $1',
            [postId]
        );
        
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Post deleted successfully" })
        };
    } catch (error) {
        console.error("Error deleting post:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "Failed to delete post",
                details: error.message
            })
        };
    }
};