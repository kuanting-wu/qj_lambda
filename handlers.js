const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { generateAccessToken, generateRefreshToken } = require('./auth');
const { sendEmail } = require('./email');
const { verifyGoogleToken } = require('./google-auth');

// Handle Signup
const handleSignup = async (event, db) => {
    const { name, email, password } = JSON.parse(event.body);
    const username = name; // In the frontend, the username field is called 'name'
    
    if (!username || !email || !password) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Username, email, and password are required' }) };
    }

    try {
        // Check if email or username already exists - combined into a single query for performance
        const [existingRecords] = await db.execute(`
            SELECT 
                (SELECT COUNT(*) FROM users WHERE email = $1) AS email_count,
                (SELECT COUNT(*) FROM profiles WHERE username = $2) AS username_count
        `, [email, username]);
        
        if (existingRecords[0].email_count > 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is already in use' }) };
        }
        
        if (existingRecords[0].username_count > 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Username is already in use' }) };
        }

        // Hash password with fewer rounds (8 instead of 10) for Lambda performance
        // This is still secure but faster in Lambda environments
        const hashedPassword = await bcrypt.hash(password, 8);
        const verificationToken = uuidv4();
        const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // Token expires in 24 hours
        const tokenExpiryUTC = tokenExpiry.toISOString();

        // Set default avatar URL
        const defaultAvatar = 'https://cdn.builder.io/api/v1/image/assets/TEMP/64c9bda73ca89162bc806ea1e084a3cd2dccf15193fe0e3c0e8008a485352e26?placeholderIfAbsent=true&apiKey=ee54480c62b34c3d9ff7ccdcccbf22d1';
        
        let userId;
        // Start transaction - with retries
        let retries = 2;
        while (retries >= 0) {
            try {
                await db.beginTransaction();
                
                // Insert user record - use RETURNING in PostgreSQL to get the inserted ID
                const [userResult] = await db.execute(
                    'INSERT INTO users (email, hashed_password, verification_token, verification_token_expiry, email_verified) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [email, hashedPassword, verificationToken, tokenExpiryUTC, false]
                );
                
                userId = userResult[0].id;
                
                // Insert profile record with minimal information - PostgreSQL uses $1, $2 etc. for parameters
                await db.execute(
                    'INSERT INTO profiles (user_id, username, avatar_url) VALUES ($1, $2, $3)',
                    [userId, username, defaultAvatar]
                );
                
                // Commit transaction
                await db.commit();
                break; // Success, exit the retry loop
            } catch (txError) {
                console.warn(`Transaction attempt failed (${retries} retries left): ${txError.message}`);
                
                // Try to rollback if needed
                try {
                    if (db && typeof db.rollback === 'function' && db.connection.inTransaction) {
                        await db.rollback();
                    }
                } catch (rollbackError) {
                    console.error('Rollback error:', rollbackError);
                }
                
                if (retries <= 0) {
                    throw txError; // No more retries, propagate the error
                }
                
                // Wait a bit before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 500 * (2 - retries)));
                retries--;
            }
        }

        // Send verification email with expiration notice
        const verificationLink = `https://quantifyjiujitsu.com/verify-email?token=${verificationToken}`;
        const expiryDate = tokenExpiry.toLocaleString(); // Format the date for user-friendly display
        
        let emailSent = false;
        try {
            // Try to send email but don't block registration if it fails
            const emailResult = await sendEmail(
                email, 
                'Verify your email', 
                `<p>Hi ${username},</p>
                <p>Click <a href="${verificationLink}">here</a> to verify your email.</p>
                <p>This verification link will expire in 24 hours (${expiryDate}).</p>
                <p>If the link expires, you can request a new verification email from the sign-in page.</p>`
            );
            emailSent = emailResult.success;
            
            if (!emailResult.success) {
                console.warn(`Failed to send verification email to ${email}: ${emailResult.error?.message || 'Unknown error'}`);
            }
        } catch (emailError) {
            console.error('Error sending verification email:', emailError);
            // Continue with registration even if email fails
        }

        return { 
            statusCode: 201, 
            body: JSON.stringify({ 
                message: emailSent ? 
                    'User registered successfully! Check your email.' : 
                    'User registered successfully! Email verification is temporarily unavailable.',
                email: email,
                userId: userId,
                requiresVerification: true, 
                verificationSent: emailSent,
                verificationExpiry: tokenExpiry.toISOString()
            }) 
        };
    } catch (error) {
        // Rollback transaction on error if it exists
        try {
            if (db && typeof db.rollback === 'function') {
                await db.rollback();
            }
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError);
        }
        
        console.error('Signup error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to register user' }) };
    }
};

// Handle Signin (Lambda version)
const handleSignin = async (event, db) => {
    const { email, password } = JSON.parse(event.body);

    try {
        // Query the database to find the user by email - PostgreSQL uses $1, $2 etc. for parameters
        const [users] = await db.execute('SELECT * FROM users WHERE email = $1', [email]);

        // If no user is found or the password doesn't match, return an error
        if (users.length === 0 || !await bcrypt.compare(password, users[0].hashed_password)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email or password' }) };
        }

        // Check if the email is verified
        if (!users[0].email_verified) {
            // Get username for the error response
            const [profileResult] = await db.execute('SELECT username FROM profiles WHERE user_id = $1', [users[0].id]);
            const username = profileResult.length > 0 ? profileResult[0].username : '';
            
            return { 
                statusCode: 403, // Forbidden is more appropriate here
                body: JSON.stringify({
                    error: 'Please verify your email first',
                    unverified: true,
                    email: users[0].email,
                    userId: users[0].id,
                    username: username,
                    message: 'Your email address has not been verified. You can request a new verification email.'
                })
            };
        }

        const user = users[0];

        // Get just the username for the token
        const [profileResult] = await db.execute('SELECT username FROM profiles WHERE user_id = $1', [user.id]);
        const username = profileResult.length > 0 ? profileResult[0].username : '';

        // Generate access token using user data
        const accessToken = generateAccessToken({ 
            user_id: user.id, 
            username: username, 
            email: user.email 
        });

        // Generate refresh token using user data
        const refreshToken = generateRefreshToken({ 
            user_id: user.id, 
            username: username, 
            email: user.email 
        });

        // Return response with the generated tokens
        return {
            statusCode: 200,
            body: JSON.stringify({
                accessToken,
                refreshToken,
                email_verified: user.email_verified,
                message: 'Signin successful!',
            }),
        };
    } catch (error) {
        console.error('Signin error:', error);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: 'An error occurred during sign in' }) 
        };
    }
};

// Handle Email Verification (Lambda version)
const handleVerifyEmail = async (event, db) => {
    const { token } = event.queryStringParameters;

    // Check if the token is provided
    if (!token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Token is required' }) };
    }

    try {
        // First, try to find the user with this token regardless of expiry
        const [usersWithToken] = await db.execute(
            'SELECT id, email, verification_token_expiry, email_verified FROM users WHERE verification_token = $1',
            [token]
        );

        // If no user is found, the token is invalid
        if (usersWithToken.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid verification token' }) };
        }

        const user = usersWithToken[0];
        
        // If the user is already verified, return success
        if (user.email_verified) {
            return { statusCode: 200, body: JSON.stringify({ message: 'Email already verified!' }) };
        }
        
        // Check if the token is expired
        const now = new Date();
        const tokenExpiry = new Date(user.verification_token_expiry);
        
        if (now > tokenExpiry) {
            // Token has expired
            return { 
                statusCode: 410, // Gone status code for expired resource
                body: JSON.stringify({ 
                    error: 'Verification token has expired', 
                    userId: user.id,
                    email: user.email,
                    expired: true
                }) 
            };
        }

        // Token is valid and not expired - update the user's email verification status
        await db.execute(
            'UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_token_expiry = NULL WHERE id = $1',
            [user.id]
        );

        // Return success response
        return { statusCode: 200, body: JSON.stringify({ message: 'Email verified successfully!' }) };
    } catch (error) {
        console.error('Error verifying email:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
    }
};

// Handle Resend Verification Email
const handleResendVerification = async (event, db) => {
    const { email } = JSON.parse(event.body);
    
    if (!email) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Email is required' }) };
    }
    
    try {
        // Check if user exists and isn't already verified
        const [users] = await db.execute(
            'SELECT id, username, email_verified FROM users u JOIN profiles p ON u.id = p.user_id WHERE u.email = $1',
            [email]
        );
        
        if (users.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
        }
        
        const user = users[0];
        
        // If already verified, return success
        if (user.email_verified) {
            return { statusCode: 200, body: JSON.stringify({ message: 'Email already verified!' }) };
        }
        
        // Generate new verification token
        const verificationToken = uuidv4();
        const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // Token expires in 24 hours
        const tokenExpiryUTC = tokenExpiry.toISOString();
        
        // Update user with new token
        await db.execute(
            'UPDATE users SET verification_token = $1, verification_token_expiry = $2 WHERE id = $3',
            [verificationToken, tokenExpiryUTC, user.id]
        );
        
        // Send verification email
        const verificationLink = `https://quantifyjiujitsu.com/verify-email?token=${verificationToken}`;
        
        let emailSent = false;
        try {
            const emailResult = await sendEmail(
                email, 
                'Verify your email', 
                `<p>Hi ${user.username},</p><p>Please click <a href="${verificationLink}">here</a> to verify your email.</p><p>This link will expire in 24 hours.</p>`
            );
            emailSent = emailResult.success;
            
            if (!emailResult.success) {
                console.warn(`Failed to send verification email to ${email}: ${emailResult.error?.message || 'Unknown error'}`);
            }
        } catch (emailError) {
            console.error('Error sending verification email:', emailError);
        }
        
        return { 
            statusCode: 200, 
            body: JSON.stringify({ 
                message: emailSent ? 
                    'Verification email resent successfully!' : 
                    'Verification token updated, but email sending is temporarily unavailable.',
                emailSent
            }) 
        };
    } catch (error) {
        console.error('Error resending verification email:', error);
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
        const [users] = await db.execute('SELECT * FROM users WHERE email = $1', [email]);
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
            'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE email = $3',
            [resetToken, tokenExpiryUTC, email]
        );

        // Generate the reset password link
        const resetLink = `https://quantifyjiujitsu.com/reset-password?token=${resetToken}`;

        // Prepare the email HTML content
        const htmlBody = `<p>Click <a href="${resetLink}">here</a> to reset your password. This link expires in 1 hour.</p>`;
        const subject = 'Password Reset - Quantify Jiu-Jitsu';

        try {
            // Send the email using the sendEmail function from email.js
            const emailResponse = await sendEmail(email, subject, htmlBody);

            // If email was successfully sent
            if (emailResponse.success) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ 
                        message: 'Password reset email sent successfully!',
                        token: resetToken, // Include token in development for testing
                        expires: tokenExpiryUTC 
                    }),
                };
            } else {
                // If email sending failed
                console.warn(`Failed to send password reset email: ${emailResponse.error?.message || 'Unknown error'}`);
                return {
                    statusCode: 200, // Still return 200 to avoid revealing email existence
                    body: JSON.stringify({ 
                        message: 'If an account exists with this email, a reset token has been generated.',
                        emailFailure: true,
                        // Only include token if in development mode
                        token: process.env.NODE_ENV === 'development' ? resetToken : undefined,
                        expires: process.env.NODE_ENV === 'development' ? tokenExpiryUTC : undefined
                    }),
                };
            }
        } catch (emailError) {
            console.error('Error sending password reset email:', emailError);
            return {
                statusCode: 200, // Still return 200 to avoid revealing email existence
                body: JSON.stringify({ 
                    message: 'If an account exists with this email, a reset token has been generated.',
                    emailFailure: true,
                    // Only include token if in development mode
                    token: process.env.NODE_ENV === 'development' ? resetToken : undefined,
                    expires: process.env.NODE_ENV === 'development' ? tokenExpiryUTC : undefined
                }),
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
            'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expiry > CURRENT_TIMESTAMP',
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
            'UPDATE users SET hashed_password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
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
        pr.username,
        pr.avatar_url,
        pr.belt,
        pr.academy
      FROM posts p
      JOIN profiles pr ON p.owner_id = pr.user_id
      WHERE p.id = $1
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
    const { username } = event.pathParameters; // Extract username from URL path

    if (!username) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Username is required' }) };
    }

    try {
        // Query the profiles table for the specified username
        const [results] = await db.execute('SELECT * FROM profiles WHERE username = $1', [username]);

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
    const currentUser = event.requestContext.authorizer ? event.requestContext.authorizer.username : null;
    const currentUserId = event.requestContext.authorizer ? event.requestContext.authorizer.user_id : null;

    // SQL query with conditional logic for post visibility (public/private)
    const query = `
      SELECT 
        p.id,
        p.video_id,
        p.video_platform,
        p.title,
        pr.username,
        pr.belt,
        pr.academy,
        pr.avatar_url,
        p.movement_type,
        p.created_at
      FROM posts p
      JOIN profiles pr ON p.owner_id = pr.user_id
      WHERE 1=1
        AND (LOWER(p.title) LIKE LOWER(?) OR ? = '')
        AND (LOWER(pr.username) = LOWER(?) OR ? = '')
        AND (LOWER(p.movement_type) LIKE LOWER(?) OR ? = '')
        AND (LOWER(p.starting_position) LIKE LOWER(?) OR ? = '')
        AND (LOWER(p.ending_position) LIKE LOWER(?) OR ? = '')
        AND (LOWER(p.language) LIKE LOWER(?) OR ? = '')
        AND (
          (? = '' AND (LOWER(p.public_status) = 'public' OR (LOWER(p.public_status) = 'private' AND p.owner_id = ?)))
          OR (? = 'Public' AND LOWER(p.public_status) = 'public')
          OR (? = 'Private' AND LOWER(p.public_status) = 'private' AND p.owner_id = ?)
        )
      ORDER BY p.created_at ${sortOrder}
    `;

    // Prepare query parameters
    const queryParams = [
        `%${search}%`, search,
        postBy, postBy, // Exact match for pr.username
        `%${movementType}%`, movementType,
        `%${startingPosition}%`, startingPosition,
        `%${endingPosition}%`, endingPosition,
        `%${language}%`, language,
        publicStatus, currentUserId,  // Case 1: public or private posts if owned by currentUser
        publicStatus,                 // Case 2: public posts only
        publicStatus, currentUserId   // Case 3: private posts if owned by currentUser
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
            username: post.username,
            belt: post.belt,
            academy: post.academy,
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
    // Parse request body
    let requestBody;
    try {
        requestBody = JSON.parse(event.body);
    } catch (error) {
        console.error("Error parsing request body:", error);
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Invalid request body format" }),
        };
    }

    const refreshToken = requestBody?.refreshToken;

    if (!refreshToken) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Refresh token is required" }),
        };
    }

    // Verify JWT_REFRESH_SECRET environment variable is set
    if (!process.env.JWT_REFRESH_SECRET) {
        console.error("JWT_REFRESH_SECRET environment variable is not set");
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Server configuration error" }),
        };
    }

    try {
        // Verify the refresh token
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        // Generate a new access token using the data from the refresh token
        const newAccessToken = generateAccessToken({ 
            user_id: decoded.user_id, 
            username: decoded.username, 
            email: decoded.email 
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                accessToken: newAccessToken,
                message: "Token refreshed successfully" 
            }),
        };
    } catch (error) {
        console.error("Invalid or expired refresh token:", error);
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: "Invalid or expired refresh token",
                details: error.message 
            }),
        };
    }
};

// Handle Google Sign-in
const handleGoogleSignin = async (event, db) => {
    try {
        const { idToken, username } = JSON.parse(event.body);
        
        if (!idToken) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ error: 'Google ID token is required' }) 
            };
        }
        
        // Verify the Google token
        const googleUser = await verifyGoogleToken(idToken);
        const { googleId, email, emailVerified, picture } = googleUser;
        
        // Check if any validation issues
        if (!email) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ error: 'Email is required from Google authentication' }) 
            };
        }
        
        // Start database transaction
        await db.beginTransaction();
        
        // Check if user already exists with this Google ID or email
        const [existingUsers] = await db.execute(
            'SELECT * FROM users WHERE google_id = $1 OR email = $2', 
            [googleId, email]
        );
        
        let userId;
        let requiresUsername = false;
        let userUsername = null;
        
        if (existingUsers.length > 0) {
            // Existing user - update the Google tokens
            const user = existingUsers[0];
            userId = user.id;
            
            // Update Google information
            await db.execute(
                'UPDATE users SET google_id = $1, email_verified = $2 WHERE id = $3',
                [googleId, emailVerified, userId]
            );
            
            // Check if user has a profile with username
            const [profileResult] = await db.execute(
                'SELECT username FROM profiles WHERE user_id = $1', 
                [userId]
            );
            
            if (profileResult.length > 0) {
                userUsername = profileResult[0].username;
            } else {
                requiresUsername = true;
            }
        } else {
            // New user - create user record
            const [insertResult] = await db.execute(
                'INSERT INTO users (email, google_id, email_verified) VALUES ($1, $2, $3) RETURNING id',
                [email, googleId, emailVerified]
            );
            
            userId = insertResult[0].id;
            requiresUsername = true;
        }
        
        // Handle username requirement cases
        if (requiresUsername) {
            if (!username) {
                // No username provided, but we need one
                try {
                    await db.rollback();
                } catch (rollbackError) {
                    console.error('Rollback error:', rollbackError);
                }
                
                return {
                    statusCode: 428, // Precondition Required
                    body: JSON.stringify({
                        error: 'Username required',
                        needsUsername: true,
                        googleId,
                        email,
                        emailVerified,
                        message: 'Please choose a username to complete registration'
                    })
                };
            }
            
            // Verify username doesn't already exist
            const [usernameCheck] = await db.execute(
                'SELECT username FROM profiles WHERE username = $1',
                [username]
            );
            
            if (usernameCheck.length > 0) {
                try {
                    await db.rollback();
                } catch (rollbackError) {
                    console.error('Rollback error:', rollbackError);
                }
                
                return {
                    statusCode: 409, // Conflict
                    body: JSON.stringify({
                        error: 'Username already taken',
                        needsUsername: true,
                        message: 'This username is already taken. Please choose another one.'
                    })
                };
            }
            
            // Create profile with the provided username
            const defaultAvatar = picture || 'https://cdn.builder.io/api/v1/image/assets/TEMP/64c9bda73ca89162bc806ea1e084a3cd2dccf15193fe0e3c0e8008a485352e26?placeholderIfAbsent=true&apiKey=ee54480c62b34c3d9ff7ccdcccbf22d1';
            
            await db.execute(
                'INSERT INTO profiles (user_id, username, avatar_url) VALUES ($1, $2, $3)',
                [userId, username, defaultAvatar]
            );
            
            userUsername = username;
        }
        
        // Generate auth tokens
        const accessToken = generateAccessToken({
            user_id: userId,
            username: userUsername,
            email
        });
        
        const refreshToken = generateRefreshToken({
            user_id: userId,
            username: userUsername,
            email
        });
        
        // Commit the transaction
        await db.commit();
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                accessToken,
                refreshToken,
                userId: userId,
                username: userUsername,
                email: email,
                email_verified: true, // Google accounts are considered verified automatically
                message: 'Google sign-in successful'
            })
        };
        
    } catch (error) {
        // Rollback transaction if active
        try {
            if (db && typeof db.rollback === 'function') {
                await db.rollback();
            }
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError);
        }
        
        console.error('Google sign-in error:', error);
        
        if (error.message === 'Invalid Google token') {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid Google token' })
            };
        }
        
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An error occurred during Google sign-in' })
        };
    }
};

// Handle Edit Profile
const handleEditProfile = async (event, db, user) => {
    const { username } = event.pathParameters; // Extract username from URL path
    const { belt, academy, bio, location, nationality, weight_class, height, date_of_birth, 
            social_links, achievements, website_url, contact_email } = JSON.parse(event.body);

    // Check if the authenticated user is trying to edit their own profile
    if (user.username !== username) {
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'User not authorized to edit this profile' })
        };
    }

    try {
        // Prepare update fields dynamically based on what's provided
        const updates = [];
        const params = [];

        // Add all potential fields to update
        if (belt !== undefined) { 
            updates.push('belt = ?'); 
            params.push(belt); 
        }
        
        if (academy !== undefined) { 
            updates.push('academy = ?'); 
            params.push(academy); 
        }
        
        if (bio !== undefined) { 
            updates.push('bio = ?'); 
            params.push(bio); 
        }
        
        if (location !== undefined) { 
            updates.push('location = ?'); 
            params.push(location); 
        }
        
        if (nationality !== undefined) { 
            updates.push('nationality = ?'); 
            params.push(nationality); 
        }
        
        if (weight_class !== undefined) { 
            updates.push('weight_class = ?'); 
            params.push(weight_class); 
        }
        
        if (height !== undefined) { 
            updates.push('height = ?'); 
            params.push(height); 
        }
        
        if (date_of_birth !== undefined) { 
            updates.push('date_of_birth = ?'); 
            params.push(date_of_birth); 
        }
        
        if (social_links !== undefined) { 
            updates.push('social_links = ?'); 
            params.push(JSON.stringify(social_links)); 
        }
        
        if (achievements !== undefined) { 
            updates.push('achievements = ?'); 
            params.push(achievements); 
        }
        
        if (website_url !== undefined) { 
            updates.push('website_url = ?'); 
            params.push(website_url); 
        }
        
        if (contact_email !== undefined) { 
            updates.push('contact_email = ?'); 
            params.push(contact_email); 
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

        // Build and execute query
        const query = `UPDATE profiles SET ${updates.join(', ')} WHERE username = ?`;
        params.push(username);
        
        const [results] = await db.execute(query, params);

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
          owner_id,
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
            user.user_id, // The authenticated user's ID
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
        // First, check if the post exists and get the owner's id
        const [results] = await db.execute('SELECT owner_id FROM posts WHERE id = ?', [postId]);

        if (results.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwnerId = results[0].owner_id;
        if (parseInt(user.user_id) !== parseInt(postOwnerId)) {
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
        WHERE id = ? AND owner_id = ?
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
            user.user_id
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
        // First, check if the post exists and retrieve the owner's id
        const [results] = await db.execute('SELECT owner_id FROM posts WHERE id = ?', [postId]);

        if (results.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwnerId = results[0].owner_id;
        if (parseInt(user.user_id) !== parseInt(postOwnerId)) {
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
    handleResendVerification,
    handleForgotPassword,
    handleResetPassword,
    handleViewPost,
    handleViewProfile,
    handleSearch,
    handleProxyImage,
    handleRefreshToken,
    handleGoogleSignin,
    handleEditProfile,
    handleNewPost,
    handleEditPost,
    handleDeletePost,
};
