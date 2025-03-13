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
        // Use username directly for filtering with the posts_with_owner view
        let usernameFilter = '';
        
        if (postBy) {
            usernameFilter = postBy;
            console.log(`Searching for posts by username: ${usernameFilter}`);
        }

        // Updated query to use the posts_with_owner view
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
            AND (LOWER(p.title) LIKE LOWER($1) OR $2 = '')
            AND (LOWER(p.owner_name) = LOWER($3) OR $4 = '')
            AND (LOWER(p.movement_type) LIKE LOWER($5) OR $6 = '')
            AND (LOWER(p.starting_position) LIKE LOWER($7) OR $8 = '')
            AND (LOWER(p.ending_position) LIKE LOWER($9) OR $10 = '')
            AND (LOWER(p.starting_top_bottom::text) = LOWER($11) OR $12 = '')
            AND (LOWER(p.ending_top_bottom::text) = LOWER($13) OR $14 = '')
            AND (LOWER(p.gi_nogi) = LOWER($15) OR $16 = '')
            AND (LOWER(p.practitioner) LIKE LOWER($17) OR $18 = '')
            AND (LOWER(p.language) LIKE LOWER($19) OR $20 = '')
            AND (
              (
                $21 = '' AND 
                (
                  LOWER(p.public_status) = 'public' OR 
                  LOWER(p.public_status) = 'subscribers' OR
                  (LOWER(p.public_status) = 'private' AND p.owner_id = $22::bigint)
                )
              )
              OR ($23 = 'public' AND LOWER(p.public_status) = 'public')
              OR ($24 = 'private' AND LOWER(p.public_status) = 'private' AND p.owner_id = $25::bigint)
              OR ($26 = 'subscribers' AND LOWER(p.public_status) = 'subscribers')
            )
          ORDER BY p.created_at ${sortOrder}
          LIMIT 100
        `;

        // Prepare query parameters
        const queryParams = [
            `%${search}%`, search,
            usernameFilter, usernameFilter, // Use the username for filtering directly
            `%${movementType}%`, movementType,
            `%${startingPosition}%`, startingPosition,
            `%${endingPosition}%`, endingPosition,
            startingTopBottom, startingTopBottom,
            endingTopBottom, endingTopBottom,
            giNogi, giNogi,
            `%${practitioner}%`, practitioner,
            `%${language}%`, language,
            publicStatus, currentUserId || 0,  // Use user_id for permission checks
            publicStatus,               
            publicStatus, currentUserId || 0,  
            publicStatus                
        ];

        console.log("Executing query with params:", {
            query: query.replace(/\s+/g, ' ').trim(),
            parameters: queryParams
        });

        // Execute the query
        const [results] = await db.execute(query, queryParams);
        console.log(`Query returned ${results.length} results`);

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