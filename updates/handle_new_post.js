// Updated handleNewPost function for owner_id
const handleNewPost = async (event, db, user) => {
    console.log("New post handler called by user:", user.username, user.user_id);
    
    if (!event.body) {
        return { 
            statusCode: 400, 
            body: JSON.stringify({ error: "Request body is required" }) 
        };
    }
    
    let postData;
    try {
        postData = JSON.parse(event.body);
    } catch (error) {
        console.error("Error parsing request body:", error);
        return { 
            statusCode: 400, 
            body: JSON.stringify({ error: "Invalid JSON in request body" }) 
        };
    }
    
    // Destructure and validate required post fields
    let {
        title,
        video_id,
        video_platform = 'YouTube',
        movement_type,
        starting_position,
        ending_position, 
        starting_top_bottom,
        ending_top_bottom,
        gi_nogi,
        practitioner,
        sequence_start_time = "0:00",
        public_status = 'public',
        language = 'English',
        notes = null
    } = postData;
    
    // Validate required fields
    if (!title || !video_id) {
        return {
            statusCode: 400,
            body: JSON.stringify({ 
                error: "Missing required fields", 
                details: "Title and video ID are required" 
            })
        };
    }
    
    // Generate a new UUID for the post using uuid7
    const postId = uuidv7();
    
    // Create variables to track if we need to clean up S3 resources on error
    let notesPath = null;
    let rollbackNeeded = false;
    
    try {
        await db.beginTransaction();
        rollbackNeeded = true;
        
        // We don't need to query for username anymore since we're using user_id directly
        // The user object already contains the user_id from the authentication
        console.log(`Creating post for user_id: ${user.user_id}`);
        
        // Upload notes to S3 if provided
        if (notes) {
            try {
                const key = `posts/${user.username}/${postId}.md`;
                await uploadMarkdown(key, notes);
                notesPath = key;
                console.log("Notes uploaded to S3:", key);
            } catch (s3Error) {
                console.error("Error uploading notes to S3:", s3Error);
                return {
                    statusCode: 500,
                    body: JSON.stringify({ 
                        error: "Failed to upload notes",
                        details: s3Error.message 
                    })
                };
            }
        }
        
        // Validate enum values for top/bottom positions
        const validPositionTypes = ['TOP', 'BOTTOM', 'NEUTRAL'];
        if (starting_top_bottom && !validPositionTypes.includes(starting_top_bottom.toUpperCase())) {
            starting_top_bottom = 'NEUTRAL';
        }
        if (ending_top_bottom && !validPositionTypes.includes(ending_top_bottom.toUpperCase())) {
            ending_top_bottom = 'NEUTRAL';
        }
        
        // Insert the post with owner_id instead of owner_name
        const insertQuery = `
            INSERT INTO posts (
              id,
              title,
              video_id,
              video_platform,
              owner_id,
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
              notes_path
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id, created_at
        `;
        
        const [result] = await db.execute(insertQuery, [
            postId,
            title,
            video_id,
            video_platform,
            user.user_id, // Using user_id instead of username now
            movement_type || null,
            starting_position || null,
            ending_position || null, 
            starting_top_bottom?.toUpperCase() || 'NEUTRAL',
            ending_top_bottom?.toUpperCase() || 'NEUTRAL',
            gi_nogi || null,
            practitioner || null,
            sequence_start_time || "0:00",
            public_status || 'public',
            language || 'English',
            notesPath
        ]);
        
        // Commit the transaction
        await db.commit();
        rollbackNeeded = false;
        
        // Return success with the post ID
        return {
            statusCode: 201,
            body: JSON.stringify({ 
                message: "Post created successfully", 
                post_id: postId,
                created_at: result[0].created_at
            })
        };
        
    } catch (error) {
        console.error("Error creating post:", error);
        
        // Rollback the transaction if needed
        if (rollbackNeeded) {
            try {
                await db.rollback();
            } catch (rollbackError) {
                console.error("Error rolling back transaction:", rollbackError);
            }
        }
        
        // Clean up S3 resources if needed
        if (notesPath) {
            try {
                await deleteMarkdown(notesPath);
                console.log("Cleaned up S3 resources:", notesPath);
            } catch (cleanupError) {
                console.error("Error cleaning up S3 resources:", cleanupError);
            }
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "Failed to create post", 
                details: error.message 
            })
        };
    }
};