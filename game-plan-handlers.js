const handleNewGamePlan = async (event, db, user) => {
    // Parse request body
    let requestBody;
    try {
        requestBody = JSON.parse(event.body);
    } catch (error) {
        console.error("Error parsing request body:", error);
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Invalid request body format" })
        };
    }

    // Validate required fields
    const { name, description, language } = requestBody;
    if (!name || name.trim() === '') {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Game plan name is required" })
        };
    }

    // Ensure language is valid or set a default
    const allowedLanguages = ['English', 'Japanese', 'Traditional Chinese'];
    const finalLanguage = allowedLanguages.includes(language) ? language : 'English';

    try {
        // Insert the game plan into the database with language
        const [gamePlanResult] = await db.execute(
            'INSERT INTO game_plans (owner_id, name, description, language) VALUES ($1, $2, $3, $4) RETURNING id, name, description, language, created_at',
            [user.user_id, name, description || null, finalLanguage] // ✅ Added `language`
        );

        return {
            statusCode: 201,
            body: JSON.stringify({ 
                message: "Game plan created successfully", 
                game_plan: gamePlanResult[0] 
            })
        };
    } catch (error) {
        console.error("Error creating game plan:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to create game plan", details: error.message })
        };
    }
};

const handleSearchGamePlans = async (event, db) => {
    const {
        search = '',
        createdBy = '',
        publicStatus = '',
        language = '',
        sortOption = 'newToOld',
    } = event.queryStringParameters || {};

    console.log("Extracted parameters:", { search, createdBy, publicStatus, language, sortOption });

    const sortOrder = sortOption === 'oldToNew' ? 'ASC' : 'DESC';

    try {
        let ownerUserId = null;

        if (createdBy) {
            const [userResult] = await db.execute(
                'SELECT user_id FROM profiles WHERE username = $1',
                [createdBy]
            );

            if (userResult.length > 0) {
                ownerUserId = userResult[0].user_id;
                console.log(`Found user_id ${ownerUserId} for username "${createdBy}"`);
            } else {
                console.log(`No user found with username "${createdBy}"`);
                return {
                    statusCode: 200,
                    body: JSON.stringify({ game_plans: [], count: 0 })
                };
            }
        }

        const conditions = [];
        const queryParams = [];
        let paramCounter = 1;

        if (search && search.trim() !== '') {
            const searchParam = `%${search.trim()}%`;
            conditions.push(`(g.name ILIKE $${paramCounter} OR g.description ILIKE $${paramCounter + 1})`);
            queryParams.push(searchParam, searchParam);
            paramCounter += 2;
        }

        if (ownerUserId) {
            conditions.push(`g.owner_id = $${paramCounter}`);
            queryParams.push(ownerUserId);
            paramCounter++;
        }

        if (publicStatus) {
            conditions.push(`g.public_status = $${paramCounter}`);
            queryParams.push(publicStatus);
            paramCounter++;
        }

        if (language) {
            conditions.push(`g.language = $${paramCounter}`);
            queryParams.push(language);
            paramCounter++;
        }

        // Add privacy conditions
        conditions.push(`(
            g.public_status = 'public' OR 
            g.public_status = 'subscribers' OR 
            (g.public_status = 'private' AND g.owner_id = $${paramCounter})
        )`);
        queryParams.push(ownerUserId);  // Add the ownerUserId here
        paramCounter++;  // Increment after adding the second parameter

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const fullQuery = `
            SELECT 
                g.id, g.name, g.description, g.language, g.public_status,
                g.created_at, g.updated_at,
                p.username as owner_name, p.belt, p.academy, p.avatar_url,
                (SELECT COUNT(*) FROM game_plan_posts gpp WHERE gpp.game_plan_id = g.id) as post_count
            FROM game_plans g
            JOIN profiles p ON g.owner_id = p.user_id
            ${whereClause}
            ORDER BY g.created_at ${sortOrder}
        `;

        console.log("Executing search game plans query:", fullQuery);
        console.log("With parameters:", queryParams);

        const [results] = await db.execute(fullQuery, queryParams);
        console.log(`Found ${results.length} game plans`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                game_plans: results,
                count: results.length
            })
        };
    } catch (error) {
        console.error("Error searching game plans:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to search game plans",
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            })
        };
    }
};

const handleViewGamePlan = async (event, db) => {
    const gamePlanId = event.pathParameters.id;
    if (!gamePlanId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Game plan ID is required" })
        };
    }

    try {
        // Fetch game plan and owner profile in one go
        const [gamePlanResult] = await db.execute(`
            SELECT gp.*, pr.name AS owner_name, pr.belt, pr.academy, pr.avatar_url
            FROM game_plans gp
            LEFT JOIN profiles pr ON gp.owner_id = pr.user_id
            WHERE gp.id = $1
        `, [gamePlanId]);

        if (gamePlanResult.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Game plan not found" })
            };
        }

        const gamePlan = gamePlanResult[0];

        // Fetch related posts with all fields from the posts table
        const [posts] = await db.execute(`
            SELECT p.id, p.title, p.video_id, p.video_platform, pr.username,
                   p.movement_type, p.starting_position, p.ending_position,
                   p.starting_top_bottom, p.ending_top_bottom, p.gi_nogi,
                   p.practitioner, p.sequence_start_time, p.public_status,
                   p.language, p.notes_path, p.created_at, p.updated_at,
                   pr.name AS owner_name, pr.belt, pr.academy, pr.avatar_url
            FROM posts p
            JOIN game_plan_posts gpp ON p.id = gpp.post_id
            JOIN profiles pr ON p.owner_id = pr.user_id
            WHERE gpp.game_plan_id = $1
            ORDER BY p.created_at DESC
        `, [gamePlanId]);

        return {
            statusCode: 200,
            body: JSON.stringify({
                game_plan: gamePlan,
                posts
            })
        };
    } catch (error) {
        console.error("Error fetching game plan with posts:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to fetch data", details: error.message })
        };
    }
};

const handleListGamePlansWithStatus = async (event, db, user) => {
    const postId = event.pathParameters?.id;

    if (!postId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Post ID is required' }),
        };
    }

    try {
        // Get all the user's game plans
        const [gamePlans] = await db.execute(
            `SELECT id, name FROM game_plans WHERE owner_id = $1`,
            [user.user_id]
        );

        // Get the game plans that contain the post
        const [gamePlansWithPost] = await db.execute(
            `SELECT game_plan_id FROM game_plan_posts WHERE post_id = $1`,
            [postId]
        );

        // Create a Set for quick lookup
        const gamePlanIdsWithPost = new Set(gamePlansWithPost.map(row => row.game_plan_id));

        // Map the result to include `containsPost` status
        const result = gamePlans.map(plan => ({
            id: plan.id,
            name: plan.name,
            containsPost: gamePlanIdsWithPost.has(plan.id)
        }));

        return {
            statusCode: 200,
            body: JSON.stringify({ gamePlans: result }),
        };
    } catch (error) {
        console.error('Error fetching game plans:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch game plans' }),
        };
    }
};

const handleUpdateGamePlans = async (event, db, user) => {
    const postId = event.pathParameters?.id;
    const { gamePlanUpdates } = JSON.parse(event.body);

    if (!postId || !Array.isArray(gamePlanUpdates)) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Post ID and gamePlanUpdates are required' }),
        };
    }

    try {
        // Start the transaction using the cachedPool method
        await db.beginTransaction();

        for (const update of gamePlanUpdates) {
            const { gamePlanId, add } = update;

            if (add) {
                // Execute the query to add the post to the game plan
                await db.execute(
                    `INSERT INTO game_plan_posts (game_plan_id, post_id) 
                     VALUES ($1, $2) 
                     ON CONFLICT (game_plan_id, post_id) DO NOTHING`,
                    [gamePlanId, postId]
                );
            } else {
                // Execute the query to remove the post from the game plan
                await db.execute(
                    `DELETE FROM game_plan_posts WHERE game_plan_id = $1 AND post_id = $2`,
                    [gamePlanId, postId]
                );
            }
        }

        // Commit the transaction using the cachedPool method
        await db.commit();

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Game plans updated successfully' }),
        };
    } catch (error) {
        // Rollback the transaction using the cachedPool method
        await db.rollback();

        console.error('Error updating game plans:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update game plans' }),
        };
    } finally {
        // Release the client connection (this will be handled by the pool itself)
        // if necessary, e.g., in a more manual setup (but it's not needed here due to the pooling mechanism)
    }
};

const handleEditGamePlan = async (event, db, user) => {
    const gamePlanId = event.pathParameters.id;

    console.log("EditGamePlan handler called for gamePlanId:", gamePlanId);
    console.log("Event headers:", JSON.stringify(event.headers));

    // Authenticate user
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

    // Fetch existing game plan to verify ownership
    const [gamePlanResults] = await db.execute('SELECT owner_id FROM game_plans WHERE id = $1', [gamePlanId]);
    if (gamePlanResults.length === 0) {
        console.log(`Game plan with id ${gamePlanId} not found`);
        return {
            statusCode: 404,
            body: JSON.stringify({ error: 'Game plan not found' })
        };
    }

    const gamePlanOwnerId = gamePlanResults[0].owner_id;
    if (user.user_id !== gamePlanOwnerId) {
        console.log(`User ${user.user_id} is not the owner of game plan ${gamePlanId}`);
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'User not authorized to edit this game plan' })
        };
    }

    // Handle HEAD request for permission check
    if (event.httpMethod === 'HEAD') {
        return {
            statusCode: 200
        };
    }

    // Handle PUT request for updating game plan
    if (event.httpMethod === 'PUT') {
        const parsedBody = JSON.parse(event.body);
        const { name, description, language, public_status } = parsedBody;

        // Validate required fields
        if (!name || !language || !public_status) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Required fields (name, language, public_status) are missing' })
            };
        }

        // Validate language
        const allowedLanguages = ['English', 'Japanese', 'Traditional Chinese'];
        if (!allowedLanguages.includes(language)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: `Language must be one of: ${allowedLanguages.join(', ')}` })
            };
        }

        // Validate public_status
        const allowedStatuses = ['public', 'private', 'subscribers'];
        if (!allowedStatuses.includes(public_status)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Public status must be one of: "public", "private", "subscribers"' })
            };
        }

        try {
            // Update game plan in the database
            const updateQuery = `
                UPDATE game_plans
                SET
                    name = $1,
                    description = $2,
                    language = $3,
                    public_status = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5 AND owner_id = $6
                RETURNING id, name, description, language, public_status, created_at, updated_at
            `;

            const [result] = await db.execute(updateQuery, [
                name,
                description,
                language,
                public_status,
                gamePlanId,
                user.user_id,
            ]);

            // Return success response with updated game plan data
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Game plan updated successfully',
                    game_plan: result[0],
                })
            };
        } catch (error) {
            console.error('Error updating game plan:', error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to update the game plan', details: error.message })
            };
        }
    }

    // If method is neither HEAD nor PUT, return method not allowed
    return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' })
    };
};


module.exports = {
 handleListGamePlansWithStatus,
 handleNewGamePlan,
 handleSearchGamePlans,
 handleUpdateGamePlans,
 handleViewGamePlan,
 handleEditGamePlan,
}