const jwt = require('jsonwebtoken');

// Generate Access Token
const generateAccessToken = (user) => {
  return jwt.sign(
    { user_name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
};

// Generate Refresh Token
const generateRefreshToken = (user) => {
  return jwt.sign(
    { user_name: user.name, email: user.email },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
};

// Authenticate Token (for middleware)
const authenticateToken = async (event) => {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Access token missing or invalid');
  }

  const token = authHeader.split(' ')[1];
  return jwt.verify(token, process.env.JWT_SECRET);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  authenticateToken,
};
