// Updated handleSearch function with full-text search
const handleSearch = async (event, db) => {
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

module.exports = handleSearch;