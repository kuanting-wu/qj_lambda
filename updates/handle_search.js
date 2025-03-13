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

        // Simplified query approach
        const simplifiedQuery = `
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
            pr.belt,
            pr.academy,
            pr.avatar_url,
            p.movement_type,
            p.created_at
          FROM 
            posts p
          JOIN 
            profiles pr ON p.owner_id = pr.user_id
          WHERE 1=1
            ${ownerUserId ? 'AND p.owner_id = $1' : ''}
            AND (
              p.public_status = 'public' OR 
              p.public_status = 'subscribers' OR
              (p.public_status = 'private' AND p.owner_id = $${ownerUserId ? 2 : 1})
            )
          ORDER BY p.created_at ${sortOrder}
          LIMIT 100
        `;

        // Simplified parameters
        const params = [];
        
        // Always add the owner user ID if it exists
        if (ownerUserId) {
            params.push(ownerUserId);
        }
        
        // Always add the current user ID for permission checks
        params.push(currentUserId || 0);
        
        // Log parameters for debugging
        console.log(`Using search parameters: ownerUserId=${ownerUserId}, currentUserId=${currentUserId || 0}`);
        console.log("Executing simplified query:", simplifiedQuery);
        console.log("Executing search query with parameters:", params);
        
        // Execute the simplified query
        const [results] = await db.execute(simplifiedQuery, params);
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