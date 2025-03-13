// Updated handleSearch function for owner_id
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
        // Updated query to join with profiles to get the username
        const query = `
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
          WHERE 
            (p.public_status = 'public' OR
             (p.public_status = 'private' AND p.owner_id = $1::bigint) OR
             (p.public_status = 'subscribers' AND EXISTS (
               SELECT 1 FROM subscriptions s WHERE s.creator_id = p.owner_id AND s.subscriber_id = $1::bigint
             )))
            ${search ? 'AND (p.title ILIKE $2 OR p.practitioner ILIKE $2)' : ''}
            ${postBy ? 'AND pr.username ILIKE $3' : ''}
            ${movementType ? 'AND p.movement_type ILIKE $4' : ''}
            ${startingPosition ? 'AND p.starting_position ILIKE $5' : ''}
            ${endingPosition ? 'AND p.ending_position ILIKE $6' : ''}
            ${startingTopBottom ? 'AND p.starting_top_bottom = $7' : ''}
            ${endingTopBottom ? 'AND p.ending_top_bottom = $8' : ''}
            ${giNogi ? 'AND p.gi_nogi = $9' : ''}
            ${practitioner ? 'AND p.practitioner ILIKE $10' : ''}
            ${publicStatus ? 'AND p.public_status = $11' : ''}
            ${language ? 'AND p.language = $12' : ''}
          ORDER BY p.created_at ${sortOrder}
          LIMIT 100
        `;

        // Prepare query parameters
        const params = [currentUserId || 0];
        let paramIndex = 2;

        if (search) {
            params.push(`%${search}%`);
        }
        if (postBy) {
            params.push(`%${postBy}%`);
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

        console.log("Executing search query with parameters:", params);
        
        // Execute the query
        const [results] = await db.execute(query, params);
        
        console.log(`Found ${results.length} results`);
        
        return {
            statusCode: 200,
            body: JSON.stringify(results),
        };
    } catch (error) {
        console.error("Error executing search:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An error occurred during search' }),
        };
    }
};