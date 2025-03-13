// Updated handleEditPost function for owner_id
const handleEditPost = async (event, db, user) => {
    const postId = event.pathParameters?.id;
    
    if (!postId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Post ID is required' }) };
    }
    
    if (!event.body) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
    }
    
    let postData;
    try {
        postData = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
    }
    
    // Extract post fields from the request
    const {
        title,
        video_id,
        video_platform,
        movement_type,
        starting_position,
        ending_position,
        starting_top_bottom,
        ending_top_bottom,
        gi_nogi,
        practitioner,
        sequence_start_time,
        public_status,
        language,
        notes
    } = postData;
    
    try {
        // Check if the post exists and belongs to the user
        const [postCheck] = await db.execute(
            'SELECT * FROM posts WHERE id = $1',
            [postId]
        );
        
        if (postCheck.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Post not found' }) };
        }
        
        const post = postCheck[0];
        
        // Check if user owns the post by comparing user_id instead of owner_name
        if (post.owner_id !== user.user_id) {
            console.log(`Access denied: User ${user.user_id} attempted to edit post ${postId} owned by ${post.owner_id}`);
            return { statusCode: 403, body: JSON.stringify({ error: 'You do not have permission to edit this post' }) };
        }
        
        // Update S3 notes if needed
        let notes_path = post.notes_path;
        
        if (notes !== undefined) {
            // Handle notes update - if null or empty, delete the file
            if (!notes) {
                if (notes_path) {
                    try {
                        await deleteMarkdown(notes_path);
                        notes_path = null;
                    } catch (error) {
                        console.error(`Error deleting markdown file: ${notes_path}`, error);
                        // Continue with the update even if file deletion fails
                    }
                }
            } else {
                // Create or update the markdown file
                try {
                    // If no existing path, generate a new one
                    if (!notes_path) {
                        notes_path = `posts/${user.username}/${postId}.md`;
                    }
                    
                    await uploadMarkdown(notes_path, notes);
                } catch (error) {
                    console.error(`Error uploading markdown file: ${notes_path}`, error);
                    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save notes' }) };
                }
            }
        }
        
        // Build the update query dynamically based on what fields are provided
        const updates = [];
        const params = [];
        let paramIndex = 1;
        
        // Add fields to update only if they are provided
        if (title !== undefined) {
            updates.push(`title = $${paramIndex++}`);
            params.push(title);
        }
        
        if (video_id !== undefined) {
            updates.push(`video_id = $${paramIndex++}`);
            params.push(video_id);
        }
        
        if (video_platform !== undefined) {
            updates.push(`video_platform = $${paramIndex++}`);
            params.push(video_platform);
        }
        
        if (movement_type !== undefined) {
            updates.push(`movement_type = $${paramIndex++}`);
            params.push(movement_type);
        }
        
        if (starting_position !== undefined) {
            updates.push(`starting_position = $${paramIndex++}`);
            params.push(starting_position);
        }
        
        if (ending_position !== undefined) {
            updates.push(`ending_position = $${paramIndex++}`);
            params.push(ending_position);
        }
        
        if (starting_top_bottom !== undefined) {
            updates.push(`starting_top_bottom = $${paramIndex++}`);
            params.push(starting_top_bottom.toUpperCase());
        }
        
        if (ending_top_bottom !== undefined) {
            updates.push(`ending_top_bottom = $${paramIndex++}`);
            params.push(ending_top_bottom.toUpperCase());
        }
        
        if (gi_nogi !== undefined) {
            updates.push(`gi_nogi = $${paramIndex++}`);
            params.push(gi_nogi);
        }
        
        if (practitioner !== undefined) {
            updates.push(`practitioner = $${paramIndex++}`);
            params.push(practitioner);
        }
        
        if (sequence_start_time !== undefined) {
            updates.push(`sequence_start_time = $${paramIndex++}`);
            params.push(sequence_start_time);
        }
        
        if (public_status !== undefined) {
            updates.push(`public_status = $${paramIndex++}`);
            params.push(public_status);
        }
        
        if (language !== undefined) {
            updates.push(`language = $${paramIndex++}`);
            params.push(language);
        }
        
        if (notes !== undefined) {
            updates.push(`notes_path = $${paramIndex++}`);
            params.push(notes_path);
        }
        
        if (updates.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No fields to update' }) };
        }
        
        // Add post ID as the last parameter
        params.push(postId);
        
        // Execute the update query
        const updateQuery = `
            UPDATE posts 
            SET ${updates.join(', ')} 
            WHERE id = $${paramIndex}
            RETURNING id
        `;
        
        const [updateResult] = await db.execute(updateQuery, params);
        
        if (updateResult.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Post not found or update failed' }) };
        }
        
        return { 
            statusCode: 200, 
            body: JSON.stringify({ 
                message: 'Post updated successfully',
                id: updateResult[0].id
            }) 
        };
    } catch (error) {
        console.error('Error updating post:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update post' }) };
    }
};