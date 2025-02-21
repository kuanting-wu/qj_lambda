const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { generateAccessToken, generateRefreshToken } = require('./auth');
const { sendEmail } = require('./email');

// Handle Signup
const handleSignup = async (event, db) => {
    const { name, email, password } = JSON.parse(event.body);
    if (!name || !email || !password) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Name, email, and password are required' }) };
    }

    const [users] = await db.execute('SELECT * FROM users WHERE name = ?', [name]);
    if (users.length > 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Name is already in use' }) };
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = uuidv4();
    await db.execute(
        'INSERT INTO users (name, email, hashed_password, verification_token, email_verified) VALUES (?, ?, ?, ?, ?)',
        [name, email, hashedPassword, verificationToken, false]
    );

    const verificationLink = `https://quantifyjiujitsu.com/verify-email?token=${verificationToken}`;
    await sendEmail(email, 'Verify your email', `<p>Click <a href="${verificationLink}">here</a> to verify.</p>`);

    return { statusCode: 201, body: JSON.stringify({ message: 'User registered successfully! Check your email.' }) };
};

// Handle Signin (Lambda version)
const handleSignin = async (event, db) => {
    const { email, password } = JSON.parse(event.body);

    // Query the database to find the user by email
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);

    // If no user is found or the password doesn't match, return an error
    if (users.length === 0 || !await bcrypt.compare(password, users[0].hashed_password)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email or password' }) };
    }

    // Check if the email is verified
    if (!users[0].email_verified) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Please verify your email first' }) };
    }

    // Generate access token using user data
    const accessToken = generateAccessToken({ user_name: users[0].name, email });

    // Generate refresh token using user data
    const refreshToken = generateRefreshToken(users[0]);

    // Return response with the generated tokens
    return {
        statusCode: 200,
        body: JSON.stringify({
            accessToken,
            refreshToken,
            email_verified: users[0].email_verified,
            message: 'Signin successful!',
        }),
    };
};

// Handle Email Verification (Lambda version)
const handleVerifyEmail = async (event, db) => {
    const { token } = event.queryStringParameters;

    // Check if the token is provided
    if (!token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Token is required' }) };
    }

    try {
        // Query the database to check if the token is valid and not expired
        const [users] = await db.execute(
            'SELECT id FROM users WHERE verification_token = ? AND verification_token_expiry > NOW()',
            [token]
        );

        // If no user is found or the token is expired, return an error
        if (users.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or expired token' }) };
        }

        // Update the user's email verification status
        await db.execute(
            'UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_token_expiry = NULL WHERE id = ?',
            [users[0].id]
        );

        // Return success response
        return { statusCode: 200, body: JSON.stringify({ message: 'Email verified successfully!' }) };
    } catch (error) {
        console.error('Error verifying email:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
};

// Handle Forgot Password
const handleForgotPassword = async (event, db) => {
    const { email } = JSON.parse(event.body);

    // Check if email is provided
    if (!email) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Email is required' }),
        };
    }

    try {
        // Check if the email exists in the database
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Email not found' }),
            };
        }

        // Generate a unique reset token using uuid
        const resetToken = uuidv4();
        const tokenExpiry = new Date(Date.now() + 1 * 60 * 60 * 1000); // Token expires in 1 hour
        const tokenExpiryUTC = tokenExpiry.toISOString(); // Convert expiry to UTC

        // Update the user's reset token and expiry in the database
        await db.execute(
            'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?',
            [resetToken, tokenExpiryUTC, email]
        );

        // Generate the reset password link
        const resetLink = `https://quantifyjiujitsu.com/reset-password?token=${resetToken}`;

        // Prepare the email HTML content
        const htmlBody = `<p>Click <a href="${resetLink}">here</a> to reset your password. This link expires in 1 hour.</p>`;
        const subject = 'Password Reset - Quantify Jiu-Jitsu';

        // Send the email using the sendEmail function from email.js
        const emailResponse = await sendEmail(email, subject, htmlBody);

        // If email was successfully sent
        if (emailResponse.success) {
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Password reset email sent successfully!' }),
            };
        } else {
            // If email sending failed
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to send password reset email' }),
            };
        }
    } catch (error) {
        console.error('Unexpected error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An unexpected error occurred' }),
        };
    }
};

// Handle Reset Password
const handleResetPassword = async (event, db) => {
    const { token, newPassword } = JSON.parse(event.body);

    // Check if both token and newPassword are provided
    if (!token || !newPassword) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Token and new password are required' }),
        };
    }

    try {
        // Check if the token is valid and not expired
        const [users] = await db.execute(
            'SELECT * FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()',
            [token]
        );

        if (users.length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid or expired token' }),
            };
        }

        // Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update the user's password and clear the reset token and expiry
        await db.execute(
            'UPDATE users SET hashed_password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
            [hashedPassword, users[0].id]
        );

        // Return success response
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Password reset successfully!' }),
        };
    } catch (error) {
        console.error('Error during password reset:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An unexpected error occurred' }),
        };
    }
};

// Handle View Post
const handleViewPost = async (event, db) => {
    const postId = event.pathParameters.id;

    // Define the query to join the posts and profiles tables
    const query = `
      SELECT 
        p.id,
        p.title,
        p.video_id,
        p.video_platform,
        p.movement_type,
        p.starting_position,
        p.ending_position,
        p.sequence_start_time,
        p.public_status,
        p.language,
        p.notes,
        pr.user_name,
        pr.avatar_url,
        pr.name,
        pr.belt
      FROM posts p
      JOIN profiles pr ON p.owner_name = pr.user_name
      WHERE p.id = ?
    `;

    try {
        // Execute the query and fetch the post data
        const [results] = await db.execute(query, [postId]);

        // Check if the post exists
        if (results.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Post not found' }) };
        }

        // Return the post data
        return {
            statusCode: 200,
            body: JSON.stringify(results[0]), // Return the first result (as there should be only one post with this ID)
        };
    } catch (error) {
        console.error('Error fetching post:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch post' }) };
    }
};

const handleViewProfile = async (event, db) => {
    const { user_name } = event.pathParameters; // Extract user_name from URL path

    if (!user_name) {
        return { statusCode: 400, body: JSON.stringify({ error: 'User name is required' }) };
    }

    try {
        // Query the profiles table for the specified user_name
        const [results] = await db.execute('SELECT * FROM profiles WHERE user_name = ?', [user_name]);

        if (results.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Profile not found' }) };
        }

        return { statusCode: 200, body: JSON.stringify(results[0]) };
    } catch (error) {
        console.error('Error retrieving profile:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};
// Handle Search
const handleSearch = async (event, db) => {
    const {
        search = '',
        postBy = '',
        movementType = '',
        startingPosition = '',
        endingPosition = '',
        publicStatus = '',
        language = '',
        sortOption = 'newToOld',
    } = event.queryStringParameters;

    const sortOrder = sortOption === 'oldToNew' ? 'ASC' : 'DESC';

    // Get the current user from the event (simulating the authenticated user)
    const currentUser = event.requestContext.authorizer ? event.requestContext.authorizer.user_name : null;

    // SQL query with conditional logic for post visibility (public/private)
    const query = `
      SELECT 
        p.id,
        p.video_id,
        p.video_platform,
        p.title,
        pr.user_name,
        pr.name,
        pr.belt,
        pr.avatar_url,
        p.movement_type,
        p.created_at
      FROM posts p
      JOIN profiles pr ON p.owner_name = pr.user_name
      WHERE 1=1
        AND (LOWER(p.title) LIKE LOWER(?) OR ? = '')
        AND (LOWER(pr.name) = LOWER(?) OR LOWER(pr.user_name) = LOWER(?) OR ? = '')
        AND (LOWER(p.movement_type) LIKE LOWER(?) OR ? = '')
        AND (LOWER(p.starting_position) LIKE LOWER(?) OR ? = '')
        AND (LOWER(p.ending_position) LIKE LOWER(?) OR ? = '')
        AND (LOWER(p.language) LIKE LOWER(?) OR ? = '')
        AND (
          (? = '' AND (LOWER(p.public_status) = 'public' OR (LOWER(p.public_status) = 'private' AND pr.user_name = ?)))
          OR (? = 'Public' AND LOWER(p.public_status) = 'public')
          OR (? = 'Private' AND LOWER(p.public_status) = 'private' AND pr.user_name = ?)
        )
      ORDER BY p.created_at ${sortOrder}
    `;

    // Prepare query parameters
    const queryParams = [
        `%${search}%`, search,
        postBy, postBy, postBy, // Exact match for pr.name or pr.user_name
        `%${movementType}%`, movementType,
        `%${startingPosition}%`, startingPosition,
        `%${endingPosition}%`, endingPosition,
        `%${language}%`, language,
        publicStatus, currentUser,  // Case 1: public or private posts if owned by currentUser
        publicStatus,               // Case 2: public posts only
        publicStatus, currentUser   // Case 3: private posts if owned by currentUser
    ];

    try {
        // Execute the query
        const [results] = await db.execute(query, queryParams);

        // Format the results
        const formattedResults = results.map(post => ({
            id: post.id,
            video_id: post.video_id,
            video_platform: post.video_platform,
            title: post.title,
            user_name: post.user_name,
            name: post.name,
            belt: post.belt,
            avatar_url: post.avatar_url,
            movement_type: post.movement_type,
            created_at: post.created_at,
        }));

        // Return the formatted results
        return {
            statusCode: 200,
            body: JSON.stringify({ posts: formattedResults }),
        };

    } catch (error) {
        console.error('Error fetching posts:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch posts' }),
        };
    }
};

// Handle Proxy Image
const handleProxyImage = async (event) => {
    const { bvid } = event.queryStringParameters;
    if (!bvid) {
        return { statusCode: 400, body: JSON.stringify({ error: 'bvid query parameter is required' }) };
    }

    // Logic for fetching and returning the image from external source (e.g., Bilibili)
    return { statusCode: 200, body: 'Image data' };
};

const handleRefreshToken = async (event, db) => {
    const refreshToken = event.body?.refreshToken; // Access refresh token from body

    if (!refreshToken) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Refresh token is required" }),
        };
    }

    try {
        // Verify the refresh token
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        // Generate a new access token using the data from the refresh token
        const newAccessToken = generateAccessToken({ user_name: decoded.user_name, email: decoded.email });

        return {
            statusCode: 200,
            body: JSON.stringify({ accessToken: newAccessToken }),
        };
    } catch (error) {
        console.error("Invalid or expired refresh token:", error);
        return {
            statusCode: 403,
            body: JSON.stringify({ error: "Invalid or expired refresh token" }),
        };
    }
};

// Handle Edit Profile
const handleEditProfile = async (event, db, user) => {
    const { user_name } = event.pathParameters; // Extract user_name from URL path
    const { name, belt, academy } = JSON.parse(event.body);

    // Check if required fields are provided
    if (!name || !belt || !academy) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Name, belt, and academy are required' })
        };
    }

    // Check if the authenticated user is trying to edit their own profile
    if (user.user_name !== user_name) {
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'User not authorized to edit this profile' })
        };
    }

    try {
        // Update the user's profile in the database
        const [results] = await db.execute(
            'UPDATE profiles SET name = ?, belt = ?, academy = ? WHERE user_name = ?',
            [name, belt, academy, user_name]
        );

        // Check if the profile was updated
        if (results.affectedRows === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Profile not found' })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Profile updated successfully' })
        };
    } catch (error) {
        console.error('Error updating profile:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server error' })
        };
    }
};

// Handle New Post
const handleNewPost = async (event, db, user) => {
    const { title, video_id, video_platform, movement_type, starting_position, ending_position, sequence_start_time, public_status, language, notes } = JSON.parse(event.body);
    const { id } = event.pathParameters; // Get the post ID from the URL path

    // Validate required fields
    if (!title || !video_id || !video_platform || !movement_type || !starting_position || !ending_position || !sequence_start_time || !public_status || !language || !notes) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'All fields are required to create a new post' })
        };
    }

    try {
        // Insert the new post into the database
        const query = `
        INSERT INTO posts (
          id,
          title,
          video_id,
          video_platform,
          owner_name,
          movement_type,
          starting_position,
          ending_position,
          sequence_start_time,
          public_status,
          language,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
        const values = [
            id,
            title,
            video_id,
            video_platform,
            user.user_name, // The authenticated user's name
            movement_type,
            starting_position,
            ending_position,
            sequence_start_time,
            public_status,
            language,
            notes
        ];

        const [result] = await db.execute(query, values);

        // Return success message
        return {
            statusCode: 201,
            body: JSON.stringify({ message: 'Post created successfully' })
        };
    } catch (error) {
        console.error('Error creating new post:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create a new post' })
        };
    }
};

// Handle Edit Post
const handleEditPost = async (event, db, user) => {
    const postId = event.pathParameters.id;
    const { title, video_id, video_platform, movement_type, starting_position, ending_position, sequence_start_time, public_status, language, notes } = JSON.parse(event.body);

    // Validate required fields
    if (!title || !video_id || !video_platform || !movement_type || !starting_position || !ending_position || !sequence_start_time || !public_status || !language || !notes) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'All fields are required to update the post' })
        };
    }

    try {
        // First, check if the post exists and get the owner's name
        const [results] = await db.execute('SELECT owner_name FROM posts WHERE id = ?', [postId]);

        if (results.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwner = results[0].owner_name;
        if (user.user_name !== postOwner) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'User not authorized to edit this post' })
            };
        }

        // Proceed with updating the post if the user is the owner
        const updateQuery = `
        UPDATE posts
        SET
          title = ?,
          video_id = ?,
          video_platform = ?,
          movement_type = ?,
          starting_position = ?,
          ending_position = ?,
          sequence_start_time = ?,
          public_status = ?,
          language = ?,
          notes = ?
        WHERE id = ? AND owner_name = ?
      `;

        await db.execute(updateQuery, [
            title,
            video_id,
            video_platform,
            movement_type,
            starting_position,
            ending_position,
            sequence_start_time,
            public_status,
            language,
            notes,
            postId,
            user.user_name
        ]);

        // Return success message
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Post updated successfully' })
        };

    } catch (error) {
        console.error('Error updating post:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update the post' })
        };
    }
};

// Handle Delete Post
const handleDeletePost = async (event, db, user) => {
    const postId = event.pathParameters.id;

    try {
        // First, check if the post exists and retrieve the owner's name
        const [results] = await db.execute('SELECT owner_name FROM posts WHERE id = ?', [postId]);

        if (results.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwner = results[0].owner_name;
        if (user.user_name !== postOwner) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'User not authorized to delete this post' })
            };
        }

        // Proceed with deleting the post if the user is the owner
        const deleteQuery = 'DELETE FROM posts WHERE id = ?';
        const [deleteResults] = await db.execute(deleteQuery, [postId]);

        // If no rows were affected, the deletion failed (post might have already been deleted)
        if (deleteResults.affectedRows === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found or already deleted' })
            };
        }

        // Send a success message
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Post deleted successfully' })
        };

    } catch (error) {
        console.error('Error deleting post:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to delete the post' })
        };
    }
};

module.exports = {
    handleSignup,
    handleSignin,
    handleVerifyEmail,
    handleForgotPassword,
    handleResetPassword,
    handleViewPost,
    handleViewProfile,
    handleSearch,
    handleProxyImage,
    handleRefreshToken,
    handleEditProfile,
    handleNewPost,
    handleEditPost,
    handleDeletePost,
};
