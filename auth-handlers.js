const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { uuidv7 } = require('uuidv7');
const { generateAccessToken, generateRefreshToken } = require('./auth');
const { sendEmail } = require('./email');
const { verifyGoogleToken } = require('./google-auth');

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

        // Get the username and avatar_url for the token
        const [profileResult] = await db.execute('SELECT username, avatar_url FROM profiles WHERE user_id = $1', [user.id]);
        const username = profileResult.length > 0 ? profileResult[0].username : '';
        const avatar_url = profileResult.length > 0 ? profileResult[0].avatar_url : null;

        // Generate access token using user data including avatar URL
        const accessToken = generateAccessToken({
            user_id: user.id,
            username: username,
            email: user.email,
            avatar_url: avatar_url
        });

        // Generate refresh token using user data including avatar URL
        const refreshToken = generateRefreshToken({
            user_id: user.id,
            username: username,
            email: user.email,
            avatar_url: avatar_url
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
                    allTokens.map(u => ({ email: u.email, token_fragment: u.verification_token?.substring(0, 8) + '...' }))
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
        return {
            statusCode: 200, body: JSON.stringify({
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
            email: decoded.email,
            avatar_url: decoded.avatar_url || null
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
        let userAvatar = null;

        if (existingUsers.length > 0) {
            // Existing user - update the Google tokens
            const user = existingUsers[0];
            userId = user.id;

            // Update Google information
            await db.execute(
                'UPDATE users SET google_id = $1, email_verified = $2 WHERE id = $3',
                [googleId, emailVerified, userId]
            );

            // Check if user has a profile with username and avatar
            const [profileResult] = await db.execute(
                'SELECT username, avatar_url FROM profiles WHERE user_id = $1',
                [userId]
            );

            if (profileResult.length > 0) {
                userUsername = profileResult[0].username;
                userAvatar = profileResult[0].avatar_url;
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
            userAvatar = defaultAvatar;
        }

        // Generate auth tokens
        const accessToken = generateAccessToken({
            user_id: userId,
            username: userUsername,
            email,
            avatar_url: userAvatar
        });

        const refreshToken = generateRefreshToken({
            user_id: userId,
            username: userUsername,
            email,
            avatar_url: userAvatar
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

module.exports = {
    handleSignup,
    handleSignin,
    handleVerifyEmail,
    handleResendVerification,
    handleForgotPassword,
    handleResetPassword,
    handleRefreshToken,
    handleGoogleSignin,
};