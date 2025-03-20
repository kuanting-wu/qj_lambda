const { uuidv7 } = require('uuidv7');
const { authenticateToken } = require('./auth');

// Handle View Post
const handleViewPost = async (event, db) => {
    const postId = event.pathParameters.id;
    const { getMarkdownUrl } = require('./s3-helper'); // Import S3 helper

    // Use the posts_with_owner view which already joins posts with profiles
    const query = `
      SELECT 
        id,
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
        notes_path,
        created_at,
        owner_name,
        avatar_url,
        belt,
        academy
      FROM posts_with_owner
      WHERE id = $1
    `;

    try {
        // Execute the query and fetch the post data
        const [results] = await db.execute(query, [postId]);

        // Check if the post exists
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

// Handle Search
const handleSearchPosts = async (event, db) => {
    console.log("Search handler called with parameters:", JSON.stringify(event.queryStringParameters));

    // Extract query parameters with defaults
    const {
        search = '',
        postBy = '',
        movementType = '',
        startingPosition = '',
        endingPosition = '',
        startingTopBottom = '',
        endingTopBottom = '',
        giNogi = '',
        practitioner = '',
        publicStatus = '',
        language = '',
        sortOption = 'newToOld',
    } = event.queryStringParameters || {};

    console.log("Extracted parameters:", {
        search, postBy, movementType, startingPosition,
        endingPosition, startingTopBottom, endingTopBottom,
        giNogi, practitioner, publicStatus, language, sortOption
    });

    const sortOrder = sortOption === 'oldToNew' ? 'ASC' : 'DESC';

    // Get the current user from the event (simulating the authenticated user)
    const currentUser = event.requestContext?.authorizer?.username || null;
    const currentUserId = event.requestContext?.authorizer?.user_id || null;

    console.log("Current user context:", { currentUser, currentUserId });

    try {
        // If postBy (username) parameter is provided, find the corresponding user_id first
        let ownerUserId = null;

        if (postBy) {
            const [userResult] = await db.execute(
                'SELECT user_id FROM profiles WHERE username = $1',
                [postBy]
            );

            if (userResult.length > 0) {
                ownerUserId = userResult[0].user_id;
                console.log(`Found user_id ${ownerUserId} for username "${postBy}"`);
            } else {
                console.log(`No user found with username "${postBy}"`);
                // If no user found with that username, return empty results
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        posts: [],
                        count: 0
                    })
                };
            }
        }

        // Build query conditions based on filters
        const conditions = [];
        const queryParams = [];
        let paramCounter = 1;

        // Handle the full-text search
        if (search && search.trim() !== '') {
            conditions.push(`p.search_vector @@ plainto_tsquery('english', $${paramCounter})`);
            queryParams.push(search.trim());
            paramCounter++;
        }

        // Filter by user if specified
        if (ownerUserId) {
            conditions.push(`p.owner_id = $${paramCounter}`);
            queryParams.push(ownerUserId);
            paramCounter++;
        }

        // Add other filter conditions
        if (movementType) {
            conditions.push(`p.movement_type = $${paramCounter}`);
            queryParams.push(movementType);
            paramCounter++;
        }

        if (startingPosition) {
            conditions.push(`p.starting_position = $${paramCounter}`);
            queryParams.push(startingPosition);
            paramCounter++;
        }

        if (endingPosition) {
            conditions.push(`p.ending_position = $${paramCounter}`);
            queryParams.push(endingPosition);
            paramCounter++;
        }

        if (startingTopBottom) {
            conditions.push(`p.starting_top_bottom = $${paramCounter}`);
            queryParams.push(startingTopBottom);
            paramCounter++;
        }

        if (endingTopBottom) {
            conditions.push(`p.ending_top_bottom = $${paramCounter}`);
            queryParams.push(endingTopBottom);
            paramCounter++;
        }

        if (giNogi) {
            conditions.push(`p.gi_nogi = $${paramCounter}`);
            queryParams.push(giNogi);
            paramCounter++;
        }

        if (practitioner) {
            conditions.push(`p.practitioner ILIKE $${paramCounter}`);
            queryParams.push(`%${practitioner}%`);
            paramCounter++;
        }

        if (publicStatus) {
            conditions.push(`p.public_status = $${paramCounter}`);
            queryParams.push(publicStatus);
            paramCounter++;
        }

        if (language) {
            conditions.push(`p.language = $${paramCounter}`);
            queryParams.push(language);
            paramCounter++;
        }

        // Add privacy conditions (always include)
        const privacyCondition = `(
            p.public_status = 'public' OR 
            p.public_status = 'subscribers' OR
            (p.public_status = 'private' AND p.owner_id = $${paramCounter})
        )`;
        conditions.push(privacyCondition);
        queryParams.push(currentUserId || 0);
        paramCounter++;

        // Build the WHERE clause
        const whereClause = conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        // Determine ranking/sorting
        let orderByClause = '';
        if (search && search.trim() !== '') {
            // If search is provided, rank results by relevance first, then by date
            // We need to reuse the same search text parameter for ranking that we used for filtering
            const searchParamIndex = queryParams.findIndex(param => param === search.trim()) + 1;
            orderByClause = `
                ORDER BY 
                    ts_rank(p.search_vector, plainto_tsquery('english', $${searchParamIndex})) DESC,
                    p.created_at ${sortOrder}
            `;
        } else {
            // Otherwise, just sort by date
            orderByClause = `ORDER BY p.created_at ${sortOrder}`;
        }

        // Complete query with all filters
        const fullQuery = `
          SELECT 
            p.id,
            p.video_id,
            p.video_platform,
            p.title,
            pr.username,
            p.gi_nogi,
            p.practitioner,
            p.starting_top_bottom,
            p.ending_top_bottom,
            p.starting_position,
            p.ending_position,
            pr.belt,
            pr.academy,
            pr.avatar_url,
            p.movement_type,
            p.created_at
          FROM 
            posts p
          JOIN 
            profiles pr ON p.owner_id = pr.user_id
          ${whereClause}
          ${orderByClause}
          LIMIT 100
        `;

        // Log query and parameters
        console.log("Executing search query:", fullQuery);
        console.log("With parameters:", queryParams);

        // Execute the query
        const [results] = await db.execute(fullQuery, queryParams);
        console.log(`Found ${results.length} results`);

        // Format the results
        const formattedResults = results.map(post => ({
            id: post.id,
            video_id: post.video_id,
            video_platform: post.video_platform,
            title: post.title,
            username: post.username,
            gi_nogi: post.gi_nogi,
            practitioner: post.practitioner,
            starting_position: post.starting_position,
            ending_position: post.ending_position,
            starting_top_bottom: post.starting_top_bottom,
            ending_top_bottom: post.ending_top_bottom,
            belt: post.belt,
            academy: post.academy,
            avatar_url: post.avatar_url,
            movement_type: post.movement_type,
            created_at: post.created_at,
        }));

        // Return the formatted results
        return {
            statusCode: 200,
            body: JSON.stringify({
                posts: formattedResults,
                count: formattedResults.length
            }),
        };
    } catch (error) {
        console.error("Error executing search:", error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code,
            query: error.query
        });

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to fetch posts',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined,
                code: process.env.NODE_ENV === 'development' ? error.code : undefined
            }),
        };
    }
};

// Handle New Post
const handleNewPost = async (event, db, user) => {
    const { uploadMarkdownToS3 } = require('./s3-helper');
    let { title, video_id, video_platform, movement_type, starting_position, ending_position, starting_top_bottom, ending_top_bottom, gi_nogi, practitioner, sequence_start_time, public_status, language, notes } = JSON.parse(event.body);

    // Generate a new UUIDv7 for the post (time-ordered)
    const id = uuidv7();

    // Validate and provide defaults for required fields
    if (!video_id || !video_platform) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Video ID and platform are required' })
        };
    }

    // Provide default values if missing
    title = title || `Video ${video_id}`;
    movement_type = movement_type || 'General';
    starting_position = starting_position || 'Not Specified';
    ending_position = ending_position || 'Not Specified';
    starting_top_bottom = starting_top_bottom || 'NEUTRAL';
    ending_top_bottom = ending_top_bottom || 'NEUTRAL';
    gi_nogi = gi_nogi || 'Gi';
    practitioner = practitioner || null;
    sequence_start_time = sequence_start_time || '00:00:00';
    public_status = public_status || 'public';
    language = language || 'English';

    // Validate language is one of the allowed values from the schema
    const allowedLanguages = ['English', 'Japanese', 'Traditional Chinese'];
    if (!allowedLanguages.includes(language)) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: `Language must be one of: ${allowedLanguages.join(', ')}` })
        };
    }

    // Validate public_status is one of the allowed values
    if (!['public', 'private', 'subscribers'].includes(public_status)) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Public status must be either "public", "private", or "subscribers"' })
        };
    }

    // Validate time format
    if (!/^\d{2}:\d{2}:\d{2}$/.test(sequence_start_time)) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Sequence start time must be in HH:MM:SS format' })
        };
    }

    try {
        // First, get the username for the current user
        const [userResult] = await db.execute('SELECT username FROM profiles WHERE user_id = $1', [user.user_id]);

        if (userResult.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'User profile not found' })
            };
        }
        
        let notesPath = null;

        // If notes are provided, upload them to S3
        if (notes && notes.trim() !== '') {
            try {
                // Use user_id instead of username for storage path stability
                notesPath = await uploadMarkdownToS3(notes, id, user.user_id);
                console.log(`Markdown uploaded successfully with path: ${notesPath}`);
            } catch (s3Error) {
                console.error('Error uploading markdown to S3:', s3Error);
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to upload notes to storage' })
                };
            }
        }

        // Ensure title doesn't exceed 63 characters as defined in the schema
        if (title.length > 63) {
            title = title.substring(0, 60) + '...';
        }

        // Insert the new post into the database with the updated schema
        const query = `
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
      `;
        const values = [
            id, // Cast explicitly to UUID type
            title,
            video_id,
            video_platform,
            user.user_id, // Using user_id instead of username
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
            notesPath
        ];

        await db.execute(query, values);

        console.log(`Post created successfully with ID: ${id}`);

        // Return success message
        return {
            statusCode: 201,
            body: JSON.stringify({
                message: 'Post created successfully',
                post_id: id,
                notes_path: notesPath
            })
        };
    } catch (error) {
        console.error('Error creating new post:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to create a new post',
                details: error.message,
                code: error.code
            })
        };
    }
};

// Handle Edit Post
const handleEditPost = async (event, db, user) => {
    const { uploadMarkdownToS3, deleteMarkdownFromS3 } = require('./s3-helper');
    const postId = event.pathParameters.id;

    console.log("EditPost handler called for postId:", postId);
    console.log("Event headers:", JSON.stringify(event.headers));

    try {
        user = await authenticateToken(event);
        console.log(`Authenticated user: ${user.user_id}`);
    } catch (authError) {
        console.error('Authentication failed:', authError.message);
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Unauthorized' })
        };
    }

    const [postResults] = await db.execute('SELECT owner_id, notes_path FROM posts WHERE id = $1', [postId]);
    if (postResults.length === 0) {
        console.log(`Post with id ${postId} not found`);
        return {
            statusCode: 404,
            body: JSON.stringify({ error: 'Post not found' })
        };
    }

    const postOwnerId = postResults[0].owner_id;
    if (user.user_id !== postOwnerId) {
        console.log(`User ${user.user_id} is not the owner of post ${postId}`);
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'User not authorized to edit this post' })
        };
    }

    if (event.httpMethod === 'HEAD') {
        return {
            statusCode: 200
        };
    }

    if (event.httpMethod === 'PUT') {
        const parsedBody = JSON.parse(event.body);
        const { title, video_id, video_platform, movement_type, starting_position, ending_position, starting_top_bottom, ending_top_bottom, gi_nogi, practitioner, sequence_start_time, public_status, language, notes } = parsedBody;

        // Validate required fields
        if (!title || !video_id || !video_platform || !movement_type || !starting_position || !ending_position || !sequence_start_time || !public_status || !language) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Required fields are missing to update the post' })
            };
        }

        // Validate language is one of the allowed values from the schema
        const allowedLanguages = ['English', 'Japanese', 'Traditional Chinese'];
        if (!allowedLanguages.includes(language)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: `Language must be one of: ${allowedLanguages.join(', ')}` })
            };
        }

        // Validate public_status is one of the allowed values
        if (!['public', 'private', 'subscribers'].includes(public_status)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Public status must be either "public", "private", or "subscribers"' })
            };
        }

        try {
            const existingNotesPath = postResults[0].notes_path;
            let newNotesPath = existingNotesPath;

            // If notes are provided and different, upload to S3 and update path
            if (notes !== undefined) {
                try {
                    // Delete existing markdown file if it exists
                    if (existingNotesPath) {
                        try {
                            await deleteMarkdownFromS3(existingNotesPath);
                            console.log(`Deleted existing markdown file: ${existingNotesPath}`);
                        } catch (deleteError) {
                            console.error('Error deleting existing markdown:', deleteError);
                        }
                    }

                    // Upload new markdown file if content is provided
                    if (notes && notes.trim() !== '') {
                        newNotesPath = await uploadMarkdownToS3(notes, postId, user.user_id);
                        console.log(`Uploaded new markdown file: ${newNotesPath}`);
                    } else {
                        newNotesPath = null;
                    }
                } catch (s3Error) {
                    console.error('Error handling markdown file:', s3Error);
                    return {
                        statusCode: 500,
                        body: JSON.stringify({ error: 'Failed to update notes file' })
                    };
                }
            }

            // Proceed with updating the post
            const updateQuery = `
                UPDATE posts
                SET
                    title = $1,
                    video_id = $2,
                    video_platform = $3,
                    movement_type = $4,
                    starting_position = $5,
                    ending_position = $6,
                    starting_top_bottom = $7,
                    ending_top_bottom = $8,
                    gi_nogi = $9,
                    practitioner = $10,
                    sequence_start_time = $11,
                    public_status = $12,
                    language = $13,
                    notes_path = $14
                WHERE id = $15 AND owner_id = $16
            `;

            await db.execute(updateQuery, [
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
                newNotesPath,
                postId,
                user.user_id
            ]);

            // Return success message
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Post updated successfully',
                    notes_path: newNotesPath
                })
            };

        } catch (error) {
            console.error('Error updating post:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to update the post', details: error.message })
            };
        }
    }
};

// Handle Delete Post
const handleDeletePost = async (event, db, user) => {
    const { deleteMarkdownFromS3 } = require('./s3-helper');
    const postId = event.pathParameters.id;

    try {
        // First, get the username for the current user
        const [userResult] = await db.execute('SELECT username FROM profiles WHERE user_id = $1', [user.user_id]);

        if (userResult.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'User profile not found' })
            };
        }

        const username = userResult[0].username;

        // Check if the post exists and if user is the owner
        const [results] = await db.execute('SELECT owner_id, notes_path FROM posts WHERE id = $1', [postId]);

        if (results.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwnerId = results[0].owner_id;
        if (user.user_id !== postOwnerId) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'User not authorized to delete this post' })
            };
        }

        // Get the notes path to delete the file from S3 if it exists
        const notesPath = results[0].notes_path;

        // If there is a markdown file, try to delete it
        if (notesPath) {
            try {
                await deleteMarkdownFromS3(notesPath);
                console.log(`Deleted markdown file: ${notesPath}`);
            } catch (s3Error) {
                console.error('Error deleting markdown file:', s3Error);
                // Continue with post deletion even if S3 delete fails
            }
        }

        // Proceed with deleting the post
        const deleteQuery = 'DELETE FROM posts WHERE id = $1 AND owner_id = $2';
        await db.execute(deleteQuery, [postId, user.user_id]);

        // Send a success message
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Post deleted successfully' })
        };

    } catch (error) {
        console.error('Error deleting post:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to delete the post', details: error.message })
        };
    }
};

const handleForkPost = async (event, db, user) => {
    const { postId } = JSON.parse(event.body);

    if (!postId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Post ID is required' }),
        };
    }

    try {
        // Get original post data
        const [post] = await db.execute(`SELECT * FROM posts WHERE id = $1`, [postId]);

        if (post.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' }),
            };
        }

        const newPostId = uuidv7();

        // Insert a new post using the original data but under the current user
        await db.execute(
            `INSERT INTO posts (
                id, title, video_id, video_platform, owner_id, movement_type, 
                starting_position, ending_position, starting_top_bottom, ending_top_bottom, 
                gi_nogi, practitioner, sequence_start_time, public_status, language, notes_path
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
                newPostId, post[0].title, post[0].video_id, post[0].video_platform,
                user.user_id, post[0].movement_type, post[0].starting_position,
                post[0].ending_position, post[0].starting_top_bottom, post[0].ending_top_bottom,
                post[0].gi_nogi, post[0].practitioner, post[0].sequence_start_time,
                post[0].public_status, post[0].language, post[0].notes_path
            ]
        );

        return {
            statusCode: 201,
            body: JSON.stringify({ message: 'Post forked successfully', newPostId }),
        };
    } catch (error) {
        console.error('Error forking post:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fork post' }),
        };
    }
};


module.exports = {
    handleViewPost,
    handleSearchPosts,
    handleNewPost,
    handleEditPost,
    handleDeletePost,
    handleForkPost,
  };