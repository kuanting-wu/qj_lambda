const mysql = require('mysql2/promise');

let cachedDb = null;
let cachedDbConfig = null; // Cache the DB credentials

const getDBConfig = async () => {
  if (cachedDbConfig) return cachedDbConfig;
 
  console.log("Getting database configuration from environment variables");
  
  // Check if required environment variables are set
  const requiredVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  
  // Get database configuration from environment variables
  cachedDbConfig = {
    host: process.env.DB_HOST,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    dbname: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306', 10)
  };
  
  console.log(`Database configuration loaded for host: ${cachedDbConfig.host}`);
  return cachedDbConfig;
};

const getDBConnection = async () => {
  if (cachedDb) return cachedDb; 

  const dbConfig = await getDBConfig();
  try {
    cachedDb = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.dbname,
      port: dbConfig.port || 3306,
      connectTimeout: 10000, // 10 seconds timeout
    });

    console.log("Database connected");
    return cachedDb;
  } catch (error) {
    console.error("Error connecting to database:", error.message);
    if (error.code) console.error("MySQL error code:", error.code);
    throw error;
  }
};

module.exports = { getDBConnection };
