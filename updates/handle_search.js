// Updated handleSearch function for owner_id with username search
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
        // First, if postBy (username) parameter is provided, we need to find the corresponding user_id
        let ownerUserId = null;
        if (postBy) {
            const [userResult] = await db.execute(
                'SELECT user_id FROM profiles WHERE username ILIKE $1 LIMIT 1',
                [`%${postBy}%`]
            );
            
            if (userResult.length > 0) {
                ownerUserId = userResult[0].user_id;
                console.log(`Found user_id ${ownerUserId} for username search "${postBy}"`);
            } else {
                console.log(`No user found with username like "${postBy}"`);
                // If no user found, we can return empty results early
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        posts: [],
                        count: 0
                    }),
                };
            }
        }

        // Build the base query using the posts_with_owner view that includes username
        const query = `
          SELECT 
            p.id,
            p.video_id,
            p.video_platform,
            p.title,
            p.owner_name as username,
            p.gi_nogi,
            p.practitioner,
            p.starting_top_bottom,
            p.ending_top_bottom,
            p.belt,
            p.academy,
            p.avatar_url,
            p.movement_type,
            p.created_at
          FROM 
            posts_with_owner p
          WHERE 1=1
            ${search ? 'AND (p.title ILIKE $1 OR p.practitioner ILIKE $1)' : ''}
            ${ownerUserId ? 'AND p.owner_id = $2' : ''}
            ${movementType ? `AND p.movement_type ILIKE $${ownerUserId ? 3 : 2}` : ''}
            ${startingPosition ? `AND p.starting_position ILIKE $${ownerUserId ? 4 : 3}` : ''}
            ${endingPosition ? `AND p.ending_position ILIKE $${ownerUserId ? 5 : 4}` : ''}
            ${startingTopBottom ? `AND p.starting_top_bottom = $${ownerUserId ? 6 : 5}` : ''}
            ${endingTopBottom ? `AND p.ending_top_bottom = $${ownerUserId ? 7 : 6}` : ''}
            ${giNogi ? `AND p.gi_nogi = $${ownerUserId ? 8 : 7}` : ''}
            ${practitioner ? `AND p.practitioner ILIKE $${ownerUserId ? 9 : 8}` : ''}
            ${publicStatus ? `AND p.public_status = $${ownerUserId ? 10 : 9}` : ''}
            ${language ? `AND p.language = $${ownerUserId ? 11 : 10}` : ''}
            AND (
              p.public_status = 'public' OR
              (p.public_status = 'private' AND p.owner_id = $${ownerUserId ? 12 : 11}) OR
              p.public_status = 'subscribers'
            )
          ORDER BY p.created_at ${sortOrder}
          LIMIT 100
        `;

        // Prepare query parameters
        const params = [];
        let paramIndex = 1;

        if (search) {
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        if (ownerUserId) {
            params.push(ownerUserId);
            paramIndex++;
        }
        
        if (movementType) {
            params.push(`%${movementType}%`);
            paramIndex++;
        }
        
        if (startingPosition) {
            params.push(`%${startingPosition}%`);
            paramIndex++;
        }
        
        if (endingPosition) {
            params.push(`%${endingPosition}%`);
            paramIndex++;
        }
        
        if (startingTopBottom) {
            params.push(startingTopBottom);
            paramIndex++;
        }
        
        if (endingTopBottom) {
            params.push(endingTopBottom);
            paramIndex++;
        }
        
        if (giNogi) {
            params.push(giNogi);
            paramIndex++;
        }
        
        if (practitioner) {
            params.push(`%${practitioner}%`);
            paramIndex++;
        }
        
        if (publicStatus) {
            params.push(publicStatus);
            paramIndex++;
        }
        
        if (language) {
            params.push(language);
            paramIndex++;
        }
        
        // Add current user ID for private post access check
        params.push(currentUserId || 0);

        console.log("Executing search query with parameters:", params);
        
        // Execute the query
        const [results] = await db.execute(query, params);
        
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
            starting_top_bottom: post.starting_top_bottom,
            ending_top_bottom: post.ending_top_bottom,
            belt: post.belt,
            academy: post.academy,
            avatar_url: post.avatar_url,
            movement_type: post.movement_type,
            created_at: post.created_at,
        }));
        
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