const jwt = require('jsonwebtoken');

// Generate Access Token
const generateAccessToken = (user) => {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET environment variable is not set');
    throw new Error('JWT_SECRET environment variable must be set');
  }
  
  return jwt.sign(
    { user_name: user.user_name || user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
};

// Generate Refresh Token
const generateRefreshToken = (user) => {
  if (!process.env.JWT_REFRESH_SECRET) {
    console.error('JWT_REFRESH_SECRET environment variable is not set');
    throw new Error('JWT_REFRESH_SECRET environment variable must be set');
  }
  
  return jwt.sign(
    { user_name: user.user_name || user.name, email: user.email },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

// Authenticate Token (for middleware)
const authenticateToken = async (event) => {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET environment variable is not set');
    throw new Error('JWT_SECRET environment variable must be set');
  }
  
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Access token missing or invalid');
  }

  const token = authHeader.split(' ')[1];
  
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    console.error('Token verification failed:', error.message);
    throw new Error(`Token verification failed: ${error.message}`);
  }
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  authenticateToken,
};
