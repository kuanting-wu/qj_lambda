const { OAuth2Client } = require('google-auth-library');

// Initialize the OAuth2 client with your Google Client ID
// This should come from environment variables in production
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token and extract the user information
 * @param {string} idToken - The Google ID token to verify
 * @returns {Promise<{googleId: string, email: string, name: string, picture: string}>} - User info
 */
const verifyGoogleToken = async (idToken) => {
  try {
    // Verify the token
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID, // Specify the CLIENT_ID of your app
    });

    // Get the payload data
    const payload = ticket.getPayload();

    // Extract relevant user information
    return {
      googleId: payload.sub, // The Google user ID
      email: payload.email,
      emailVerified: payload.email_verified || false,
      name: payload.name || '',
      picture: payload.picture || '',
    };
  } catch (error) {
    console.error('Error verifying Google token:', error);
    throw new Error('Invalid Google token');
  }
};

module.exports = { verifyGoogleToken };