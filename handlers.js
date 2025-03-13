const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { uuidv7 } = require('uuidv7');
const { generateAccessToken, generateRefreshToken } = require('./auth');
const { sendEmail } = require('./email');
const { verifyGoogleToken } = require('./google-auth');

// Helper function to add CORS headers to all responses
const corsHeaders = (event) => {
    const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:8080';
    
    // Define allowed origins
    const allowedOrigins = [
        'http://localhost:8080',
        'http://localhost:8081',
        'https://quantifyjiujitsu.com',
        'https://www.quantifyjiujitsu.com',
        'https://dev.quantifyjiujitsu.com',
        'https://staging.quantifyjiujitsu.com',
        'https://api-dev.quantifyjiujitsu.com',
        'https://api.quantifyjiujitsu.com',
        'https://api-staging.quantifyjiujitsu.com'
    ];
    
    // Use the origin if it's in the allowed list, otherwise use a default
    const responseOrigin = allowedOrigins.includes(origin) ? origin : 'https://quantifyjiujitsu.com';
    
    return {
        'Access-Control-Allow-Origin': responseOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Amz-Date, X-Amz-Security-Token, Accept, Origin, Referer, User-Agent',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400'
    };
};

// Helper function to wrap all responses with CORS headers
const corsResponse = (event, statusCode, body) => {
    return {
        statusCode,
        headers: corsHeaders(event),
        body: JSON.stringify(body)
    };
};

// Handle Signup
const handleSignup = async (event, db) => {
    let username, email, password;

    try {
        console.log("Starting signup process with event body:", event.body);
        const parsedBody = JSON.parse(event.body);
        username = parsedBody.username; // Username field from frontend
        email = parsedBody.email;
        password = parsedBody.password;
        
        console.log(`Signup attempt for username: ${username}, email: ${email}`);
        
        if (!username || !email || !password) {
            console.log("Missing required fields for signup");
            return { statusCode: 400, body: JSON.stringify({ error: 'Username, email, and password are required' }) };
        }
    } catch (parseError) {
        console.error("Error parsing signup request:", parseError);
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request format', details: parseError.message }) };
    }

    try {
        console.log("Starting database check for existing user...");
        
        // Check if email or username already exists - combined into a single query for performance
        let existingRecords;
        try {
            console.log(`Checking if email "${email}" or username "${username}" already exists...`);
            const queryResult = await db.execute(`
                SELECT 
                    (SELECT COUNT(*) FROM users WHERE email = $1) AS email_count,
                    (SELECT COUNT(*) FROM profiles WHERE username = $2) AS username_count
            `, [email, username]);
            
            existingRecords = queryResult[0];
            
            console.log("Database check complete:", 
                existingRecords && existingRecords[0] ? 
                    `email_count: ${existingRecords[0].email_count}, username_count: ${existingRecords[0].username_count}` : 
                    "No results returned"
            );
        } catch (queryError) {
            console.error("Error checking for existing user:", queryError);
            throw queryError; // Re-throw to be caught by outer try-catch
        }
        
        if (existingRecords[0].email_count > 0) {
            console.log("Email already in use");
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is already in use' }) };
        }
        
        if (existingRecords[0].username_count > 0) {
            console.log("Username already in use");
            return { statusCode: 400, body: JSON.stringify({ error: 'Username is already in use' }) };
        }

        // Hash password with fewer rounds (8 instead of 10) for Lambda performance
        // This is still secure but faster in Lambda environments
        const hashedPassword = await bcrypt.hash(password, 8);
        const verificationToken = uuidv7(); // Using UUIDv7 for all IDs for consistency
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
        const emailStartTime = Date.now();
        console.log("Starting email sending process...");
        
        try {
            // Set a timeout for the email operation to prevent Lambda timeout
            const emailTimeoutMs = 1500; // 1.5 seconds max for email (SES has 1 second timeout)
            
            // Define a timeout promise
            const emailTimeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Email operation timed out after ${emailTimeoutMs}ms`));
                }, emailTimeoutMs);
            });
            
            // Email sending promise
            const emailPromise = sendEmail(
                email, 
                'Verify your email', 
                `<p>Hi ${username},</p>
                <p>Click <a href="${verificationLink}">here</a> to verify your email.</p>
                <p>This verification link will expire in 24 hours (${expiryDate}).</p>
                <p>If the link expires, you can request a new verification email from the sign-in page.</p>`
            );
            
            // Race the promises
            const emailResult = await Promise.race([emailPromise, emailTimeoutPromise]);
            const emailDuration = Date.now() - emailStartTime;
            
            console.log(`Email sending completed in ${emailDuration}ms`);
            emailSent = emailResult.success;
            
            if (!emailResult.success) {
                console.warn(`Failed to send verification email to ${email}: ${emailResult.error?.message || 'Unknown error'}`);
            }
        } catch (emailError) {
            const emailDuration = Date.now() - emailStartTime;
            console.error(`Error sending verification email after ${emailDuration}ms:`, emailError.message);
            
            if (emailError.message.includes('timed out')) {
                console.warn('Email sending was aborted due to timeout - continuing with registration');
            }
            
            // Continue with registration even if email fails
        }
        
        console.log("Email process complete, continuing with response...");

        // Log information about the final state
        console.log(`Registration process complete: userId=${userId}, emailSent=${emailSent}`);
        
        const responseData = { 
            message: emailSent ? 
                'User registered successfully! Check your email.' : 
                'User registered successfully! Email verification is temporarily unavailable.',
            email: email,
            userId: userId,
            requiresVerification: true, 
            verificationSent: emailSent,
            verificationExpiry: tokenExpiry.toISOString()
        };
        
        // Always include email configuration status for now to help with debugging
        responseData.debug = {
            ses_email_from_set: Boolean(process.env.SES_EMAIL_FROM),
            ses_email_from_value: process.env.SES_EMAIL_FROM || 'not set',
            email_service_status: emailSent ? 'operational' : 'unavailable',
            verification_token: verificationToken, // Include token for testing
            verification_link: verificationLink // Include link for testing
        };
        
        console.log("Returning registration response");
        return { 
            statusCode: 201, 
            body: JSON.stringify(responseData)
        };
    } catch (error) {
        // Rollback transaction on error if it exists
        try {
            if (db && typeof db.rollback === 'function' && db.connection.inTransaction) {
                await db.rollback();
                console.log("Transaction rolled back successfully");
            }
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError);
        }
        
        // Detailed error logging
        console.error('Signup error:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            stack: error.stack,
            queryError: error.query || 'No query info',
            params: error.params || 'No params info'
        });
        
        // Return more specific error message for debugging
        return { 
            statusCode: 500, 
            body: JSON.stringify({ 
                error: 'Failed to register user',
                message: process.env.NODE_ENV === 'development' ? error.message : undefined,
                code: process.env.NODE_ENV === 'development' ? error.code : undefined
            }) 
        };
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
    console.log("Email verification handler called with event:", JSON.stringify(event));
    console.log("Query parameters:", JSON.stringify(event.queryStringParameters));
    
    // Safely extract token
    const token = event.queryStringParameters?.token;
    
    console.log("Extracted token:", token);

    // Check if the token is provided
    if (!token) {
        console.log("No token provided in query parameters");
        return { statusCode: 400, body: JSON.stringify({ error: 'Token is required' }) };
    }

    try {
        console.log(`Looking up user with token: ${token}`);
        
        // First, try to find the user with this token regardless of expiry
        const [usersWithToken] = await db.execute(
            'SELECT id, email, verification_token_expiry, email_verified FROM users WHERE verification_token = $1',
            [token]
        );
        
        console.log(`Database query complete, found ${usersWithToken.length} users with this token`);
        if (usersWithToken.length > 0) {
            console.log("User details:", JSON.stringify({
                id: usersWithToken[0].id,
                email: usersWithToken[0].email,
                email_verified: usersWithToken[0].email_verified,
                verification_token_expiry: usersWithToken[0].verification_token_expiry
            }));
        }

        // If no user is found, the token is invalid
        if (usersWithToken.length === 0) {
            console.log("No user found with this token - invalid token");
            // Debug: Query to check if any tokens exist in the database
            try {
                const [allTokens] = await db.execute(
                    'SELECT email, verification_token FROM users WHERE verification_token IS NOT NULL LIMIT 5'
                );
                console.log(`Found ${allTokens.length} users with tokens. Sample tokens:`, 
                    allTokens.map(u => ({email: u.email, token_fragment: u.verification_token?.substring(0, 8) + '...' }))
                );
            } catch (debugError) {
                console.error("Error in debug query:", debugError);
            }
            
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
        console.log(`Verifying email for user ${user.id} with token ${token}`);
        
        try {
            await db.execute(
                'UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_token_expiry = NULL WHERE id = $1',
                [user.id]
            );
            console.log(`Successfully verified email for user ${user.id} (${user.email})`);
        } catch (updateError) {
            console.error(`Error updating user verification status:`, updateError);
            throw updateError;
        }

        // Return success response
        console.log("Returning success response");
        return { statusCode: 200, body: JSON.stringify({ 
            message: 'Email verified successfully!',
            email: user.email,
            verified: true 
        })
        };
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
        const verificationToken = uuidv7();
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

        // Generate a unique reset token using uuidv7
        const resetToken = uuidv7();
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
    const { getMarkdownUrl } = require('./s3-helper'); // Import S3 helper

    // Define the query to join the posts and profiles tables with the new structure
    const query = `
      SELECT 
        p.id,
        p.title,
        p.video_id,
        p.video_platform,
        p.movement_type,
        p.starting_position,
        p.ending_position,
        p.starting_top_bottom,
        p.ending_top_bottom,
        p.gi_nogi,
        p.practitioner,
        p.sequence_start_time,
        p.public_status,
        p.language,
        p.notes_path,
        p.created_at,
        p.owner_name,
        pr.avatar_url,
        pr.belt,
        pr.academy
      FROM posts p
      JOIN profiles pr ON p.owner_name = pr.username
      WHERE p.id = $1
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
        let usernameFilter = '';
        
        if (postBy) {
            // Use the username directly as a filter for the view
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
        `;

        // Prepare query parameters - using the posts_with_owner view which provides owner_name
        const queryParams = [
            `%${search}%`, search,
            usernameFilter, usernameFilter, // Use the username for filtering
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
        console.error('Error fetching posts:', error);
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
    console.log("Edit profile handler called", { pathParameters: event.pathParameters, user });
    const user_id = event.pathParameters.user_id; // Extract user_id from URL path
    
    try {
        // Parse the request body and extract all fields
        const { 
            username: new_username, // Frontend might send username directly
            name, // New name field (not unique)
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
                updates.push(`social_links = $${paramCounter++}`); 
                // Handle social_links based on type - frontend may already send it as a string
                const socialLinksValue = typeof social_links === 'string' 
                    ? social_links  // Already a JSON string
                    : JSON.stringify(social_links); // Convert object to JSON string
                params.push(socialLinksValue); 
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
                
                // Update all posts' owner_name field 
                // Note: After migration, this will update both owner_name and owner_id if needed
                await db.execute(
                    'UPDATE posts SET owner_name = $1 WHERE owner_name = $2',
                    [new_username, user.username]
                );
                console.log(`Updated posts owner_name from ${user.username} to ${new_username}`);
                
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
                
                // Generate new tokens with updated username
                const { generateAccessToken, generateRefreshToken } = require('./auth');
                
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

            // Commit transaction if one is in progress
            if (db.connection.inTransaction) {
                await db.commit();
                console.log("Transaction committed successfully");
            }

            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    message: 'Profile updated successfully',
                    username: new_username || user.username,
                    ...updatedTokens
                })
            };
        } catch (innerError) {
            // Rollback transaction if in progress
            if (db.connection.inTransaction) {
                try {
                    await db.rollback();
                    console.log("Transaction rolled back due to error");
                } catch (rollbackError) {
                    console.error("Rollback error:", rollbackError);
                }
            }
            
            throw innerError; // Re-throw to be caught by outer catch block
        }
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
    const { uploadMarkdownToS3 } = require('./s3-helper');
    let { title, video_id, video_platform, movement_type, starting_position, ending_position, starting_top_bottom, ending_top_bottom, gi_nogi, practitioner, sequence_start_time, public_status, language, notes } = JSON.parse(event.body);
    
    // Generate a new UUIDv7 for the post (time-ordered)
    const id = uuidv7();

    console.log('Received new post request with data:', {
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
        language
    });
    console.log('Event path:', event.path);
    console.log('Event HTTP method:', event.httpMethod);
    console.log('Event path parameters:', event.pathParameters);
    console.log('Event request context:', event.requestContext?.authorizer);
    console.log('Generated server-side UUIDv7:', id);

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
        
        const username = userResult[0].username;
        let notesPath = null;
        
        // If notes are provided, upload them to S3
        if (notes && notes.trim() !== '') {
            try {
                notesPath = await uploadMarkdownToS3(notes, id, username);
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
          owner_name,
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
            username, // Using username instead of user_id now
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
    
    // For OPTIONS requests, return immediately with CORS headers
    if (event.httpMethod === 'OPTIONS') {
        console.log("Handling OPTIONS request for EditPost");
        return {
            statusCode: 204,
            headers: corsHeaders(event),
            body: ''
        };
    }
    
    // Parse the request body
    const parsedBody = JSON.parse(event.body);
    const { title, video_id, video_platform, movement_type, starting_position, ending_position, starting_top_bottom, ending_top_bottom, gi_nogi, practitioner, sequence_start_time, public_status, language, notes } = parsedBody;

    // Validate required fields
    if (!title || !video_id || !video_platform || !movement_type || !starting_position || !ending_position || !sequence_start_time || !public_status || !language) {
        return corsResponse(event, 400, { error: 'Required fields are missing to update the post' });
    }

    // Validate language is one of the allowed values from the schema
    const allowedLanguages = ['English', 'Japanese', 'Traditional Chinese'];
    if (!allowedLanguages.includes(language)) {
        return corsResponse(event, 400, { error: `Language must be one of: ${allowedLanguages.join(', ')}` });
    }

    // Validate public_status is one of the allowed values
    if (!['public', 'private', 'subscribers'].includes(public_status)) {
        return corsResponse(event, 400, { error: 'Public status must be either "public", "private", or "subscribers"' });
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
        
        const username = userResult[0].username;
        
        // Check if the post exists and if current user is the owner
        const [postResults] = await db.execute('SELECT owner_name, notes_path FROM posts WHERE id = $1', [postId]);

        if (postResults.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwnerName = postResults[0].owner_name;
        if (username !== postOwnerName) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'User not authorized to edit this post' })
            };
        }

        // Get the existing notes path, if any
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
                        // Continue with update even if delete fails
                    }
                }
                
                // Upload new markdown file if content is provided
                if (notes && notes.trim() !== '') {
                    newNotesPath = await uploadMarkdownToS3(notes, postId, username);
                    console.log(`Uploaded new markdown file: ${newNotesPath}`);
                } else {
                    // If notes is empty, set notes_path to null
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
        WHERE id = $15 AND owner_name = $16
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
            username
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
        const [results] = await db.execute('SELECT owner_name, notes_path FROM posts WHERE id = $1', [postId]);

        if (results.length === 0) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Post not found' })
            };
        }

        // Check if the authenticated user is the owner of the post
        const postOwnerName = results[0].owner_name;
        if (username !== postOwnerName) {
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
        const deleteQuery = 'DELETE FROM posts WHERE id = $1 AND owner_name = $2';
        await db.execute(deleteQuery, [postId, username]);

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
