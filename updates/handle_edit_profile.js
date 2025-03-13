// Updated handleEditProfile function that no longer updates owner_name in posts
const handleEditProfile = async (event, db, user) => {
    console.log("Edit profile handler called", { pathParameters: event.pathParameters, user });
    const user_id = event.pathParameters.user_id; // Extract user_id from URL path
    
    try {
        // Parse the request body and extract all fields
        const { 
            username: new_username, // Frontend might send username directly
            name, // Name field (not unique)
            belt, academy, bio, location, nationality, weight_class, height, date_of_birth,
            social_links, achievements, website_url, contact_email, avatar_url
        } = JSON.parse(event.body);
        
        console.log("Profile update data:", { path_user_id: user_id, auth_user_id: user.user_id, username: user.username });

        // Check if the authenticated user is trying to edit their own profile
        if (user.user_id !== user_id && String(user.user_id) !== String(user_id)) {
            console.warn(`Auth mismatch: User ${user.user_id} attempting to edit profile for user ${user_id}`);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'User not authorized to edit this profile' })
            };
        }

        // Prepare update fields dynamically based on what's provided
        const updates = [];
        const params = [];
        let paramCounter = 1; // For PostgreSQL $1, $2 style parameters

        try {
            // Start transaction for safety when changing username
            if (new_username) {
                await db.beginTransaction();
                console.log("Transaction started for username change");
            }
            
            // Add all potential fields to update
            if (belt !== undefined) { 
                updates.push(`belt = $${paramCounter++}`); 
                params.push(belt); 
            }
            
            if (academy !== undefined) { 
                updates.push(`academy = $${paramCounter++}`); 
                params.push(academy); 
            }
            
            if (bio !== undefined) { 
                updates.push(`bio = $${paramCounter++}`); 
                params.push(bio); 
            }
            
            if (location !== undefined) { 
                updates.push(`location = $${paramCounter++}`); 
                params.push(location); 
            }
            
            if (nationality !== undefined) { 
                updates.push(`nationality = $${paramCounter++}`); 
                params.push(nationality); 
            }
            
            if (weight_class !== undefined) { 
                updates.push(`weight_class = $${paramCounter++}`); 
                params.push(weight_class); 
            }
            
            if (height !== undefined) { 
                updates.push(`height = $${paramCounter++}`); 
                params.push(height); 
            }
            
            if (date_of_birth !== undefined) { 
                updates.push(`date_of_birth = $${paramCounter++}`); 
                params.push(date_of_birth); 
            }
            
            if (social_links !== undefined) {
                // Process social links - either store as JSON or as stringified JSON
                if (typeof social_links === 'string') {
                    updates.push(`social_links = $${paramCounter++}`);
                    params.push(social_links);
                } else if (typeof social_links === 'object') {
                    updates.push(`social_links = $${paramCounter++}`);
                    params.push(JSON.stringify(social_links));
                }
            }
            
            if (achievements !== undefined) { 
                updates.push(`achievements = $${paramCounter++}`); 
                params.push(achievements); 
            }
            
            if (website_url !== undefined) { 
                updates.push(`website_url = $${paramCounter++}`); 
                params.push(website_url); 
            }
            
            if (contact_email !== undefined) { 
                updates.push(`contact_email = $${paramCounter++}`); 
                params.push(contact_email); 
            }
            
            if (avatar_url !== undefined) { 
                updates.push(`avatar_url = $${paramCounter++}`); 
                params.push(avatar_url); 
            }
            
            if (name !== undefined) { 
                updates.push(`name = $${paramCounter++}`); 
                params.push(name); 
            }
            
            // Handle username change separately
            if (new_username && new_username !== user.username) {
                // Check if the new username is already taken
                const [usernameCheck] = await db.execute(
                    'SELECT username FROM profiles WHERE username = $1 AND username != $2', 
                    [new_username, user.username]
                );
                
                if (usernameCheck.length > 0) {
                    if (db.connection.inTransaction) {
                        await db.rollback();
                    }
                    return {
                        statusCode: 409,
                        body: JSON.stringify({ error: 'Username already taken' })
                    };
                }
                
                // Start transaction if not already in one
                if (!db.connection.inTransaction) {
                    await db.beginTransaction();
                    console.log("Transaction started for username change");
                }
                
                // No need to update posts.owner_name anymore since we're using owner_id
                // Just update the username in the profiles table
                
                updates.push(`username = $${paramCounter++}`);
                params.push(new_username);
                console.log(`Username change requested: ${user.username} → ${new_username}`);
            }
            
            // Always add updated_at
            updates.push('updated_at = CURRENT_TIMESTAMP');
            
            // If no fields to update, return
            if (updates.length === 0) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'No fields to update' })
                };
            }

            // Build and execute query with PostgreSQL parameters - use user_id instead of username
            const query = `UPDATE profiles SET ${updates.join(', ')} WHERE user_id = $${paramCounter}`;
            params.push(user.user_id); // Use user_id from the authenticated user for better reliability
            
            console.log("Executing update query:", { query, params });
            const [results] = await db.execute(query, params);
            
            // Check if the profile was updated
            if (results.affectedRows === 0) {
                if (db.connection.inTransaction) {
                    await db.rollback();
                }
                return {
                    statusCode: 404,
                    body: JSON.stringify({ error: 'Profile not found' })
                };
            }

            // If username was changed, generate new tokens
            let updatedTokens = {};
            if (new_username && new_username !== user.username) {
                console.log(`Username changed from ${user.username} to ${new_username}, generating new tokens`);
                
                // Create new tokens with the updated username
                const accessToken = generateAccessToken({ 
                    user_id: user.user_id,
                    username: new_username,
                    email: user.email
                });
                
                const refreshToken = generateRefreshToken({
                    user_id: user.user_id,
                    username: new_username,
                    email: user.email
                });
                
                updatedTokens = {
                    accessToken,
                    refreshToken
                };
            }
            
            // Commit the transaction if in one
            if (db.connection.inTransaction) {
                await db.commit();
                console.log("Transaction committed successfully");
            }
            
            // Return success with new tokens if username was changed
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    message: 'Profile updated successfully',
                    usernameChanged: new_username && new_username !== user.username,
                    ...updatedTokens
                })
            };
            
        } catch (error) {
            // Rollback the transaction if in one
            if (db.connection.inTransaction) {
                await db.rollback();
                console.log("Transaction rolled back due to error:", error.message);
            }
            throw error; // Re-throw for the outer catch block
        }
    } catch (error) {
        console.error("Error updating profile:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Failed to update profile',
                details: error.message
            })
        };
    }
};

module.exports = handleEditProfile;