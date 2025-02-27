const { SecretsManager } = require('aws-sdk');
const mysql = require('mysql2/promise');

const secretsManager = new SecretsManager({
  httpOptions: { timeout: 5000 } // Reduce timeout to 5 seconds
});
let cachedDb = null;
let cachedDbConfig = null; // Cache the DB credentials

const getDBConfig = async () => {
  if (cachedDbConfig) return cachedDbConfig;
 
  try {
    const secretId = process.env.SECRET_NAME || "my-db-credentials";
    console.log(`Fetching database credentials from Secrets Manager. Secret ID: ${secretId}`);
    
    const secret = await Promise.race([
      secretsManager.getSecretValue({ SecretId: secretId }).promise(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Secrets Manager timeout after 4s')), 4000)
      )
    ]);

    cachedDbConfig = JSON.parse(secret.SecretString);
    console.log("Database credentials fetched from Secrets Manager successfully");
    return cachedDbConfig;
  } catch (error) {
    console.error(`Error fetching from Secrets Manager: ${error.message}`);
    console.error(`Error code: ${error.code}, request ID: ${error.requestId}`);
    
    // Fallback for testing/dev only (remove in production)
    if (process.env.NODE_ENV === 'development' && process.env.DB_HOST) {
      console.log("Using environment variables as fallback for development");
      return {
        host: process.env.DB_HOST,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        dbname: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306
      };
    }
    
    throw error;
  }
};

const getDBConnection = async () => {
  if (cachedDb) return cachedDb; 

  const dbConfig = await getDBConfig();
  cachedDb = await mysql.createConnection({
    host: dbConfig.host,
    user: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.dbname,
    port: dbConfig.port || 3306,
  });

  console.log("Database connected");
  return cachedDb;
};

module.exports = { getDBConnection };
