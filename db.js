const { Pool } = require('pg');

let cachedPool = null;
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
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '5432', 10) // Default PostgreSQL port
  };
  
  console.log(`Database configuration loaded for host: ${cachedDbConfig.host}`);
  return cachedDbConfig;
};

const getDBConnection = async () => {
  if (cachedPool) return cachedPool; 

  const dbConfig = await getDBConfig();
  try {
    console.log(`Attempting to connect to PostgreSQL database at ${dbConfig.host}:${dbConfig.port}`);
    
    // Create a new pool
    cachedPool = new Pool({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      port: dbConfig.port,
      // Connect timeout in ms
      connectionTimeoutMillis: 5000,
      // Idle timeout in ms
      idleTimeoutMillis: 30000, 
      // Max clients
      max: 5
    });
    
    // Test the connection
    const client = await cachedPool.connect();
    client.release();
    
    console.log("Database connected successfully");
    
    // Add execute method to match MySQL interface so we don't have to change handler code
    cachedPool.execute = async (text, params) => {
      const result = await cachedPool.query(text, params);
      return [result.rows, result.fields];
    };
    
    // Add transaction methods to match MySQL interface
    cachedPool.beginTransaction = async () => {
      const client = await cachedPool.connect();
      cachedPool.client = client;
      await client.query('BEGIN');
    };
    
    cachedPool.commit = async () => {
      if (cachedPool.client) {
        await cachedPool.client.query('COMMIT');
        cachedPool.client.release();
        cachedPool.client = null;
      }
    };
    
    cachedPool.rollback = async () => {
      if (cachedPool.client) {
        await cachedPool.client.query('ROLLBACK');
        cachedPool.client.release();
        cachedPool.client = null;
      }
    };
    
    // Add inTransaction property 
    Object.defineProperty(cachedPool, 'connection', {
      get: function() {
        return {
          inTransaction: Boolean(cachedPool.client)
        };
      }
    });
    
    return cachedPool;
  } catch (error) {
    console.error("Error connecting to PostgreSQL database:", error.message);
    console.error("Database connection details:", {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database,
      port: dbConfig.port
    });
    throw error;
  }
};

module.exports = { getDBConnection };
