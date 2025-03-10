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

  try {
    const dbConfig = await getDBConfig();
    console.log(`Attempting to connect to PostgreSQL database at ${dbConfig.host}:${dbConfig.port}`);
    
    // Create a new pool with SSL enabled and optimized for Lambda
    cachedPool = new Pool({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      port: dbConfig.port,
      // Increase connect timeout for Lambda cold starts
      connectionTimeoutMillis: 8000,
      // Idle timeout in ms
      idleTimeoutMillis: 10000, 
      // Max clients - reduced for Lambda
      max: 1,
      // Optimize for Lambda - don't create too many connections
      min: 0,
      // Enable SSL but allow unauthorized certificates
      ssl: {
        rejectUnauthorized: false
      },
      // Add statement timeout to prevent long-running queries
      statement_timeout: 5000
    });
    
    // Test the connection with an appropriate timeout for Lambda
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout - could not connect to database')), 7500);
    });
    
    const connectionPromise = async () => {
      const client = await cachedPool.connect();
      client.release(true); // Force release with true parameter
      return true;
    };
    
    await Promise.race([connectionPromise(), timeoutPromise]);
    
    console.log("Database connected successfully");
    
    // Add execute method to match MySQL interface so we don't have to change handler code
    cachedPool.execute = async (text, params) => {
      try {
        const result = await cachedPool.query(text, params);
        return [result.rows, result.fields];
      } catch (error) {
        console.error('SQL Query error:', error.message);
        console.error('Query:', text);
        console.error('Params:', params);
        throw error;
      }
    };
    
    // Add transaction methods to match MySQL interface
    cachedPool.beginTransaction = async () => {
      try {
        const client = await cachedPool.connect();
        cachedPool.client = client;
        await client.query('BEGIN');
      } catch (error) {
        console.error('Error beginning transaction:', error.message);
        throw error;
      }
    };
    
    cachedPool.commit = async () => {
      if (!cachedPool.client) {
        console.warn('Attempted to commit without an active transaction');
        return;
      }
      
      try {
        await cachedPool.client.query('COMMIT');
        cachedPool.client.release();
        cachedPool.client = null;
      } catch (error) {
        console.error('Error committing transaction:', error.message);
        if (cachedPool.client) {
          try {
            cachedPool.client.release();
          } catch (releaseError) {
            console.error('Error releasing client after commit error:', releaseError.message);
          }
          cachedPool.client = null;
        }
        throw error;
      }
    };
    
    cachedPool.rollback = async () => {
      if (!cachedPool.client) {
        console.warn('Attempted to rollback without an active transaction');
        return;
      }
      
      try {
        await cachedPool.client.query('ROLLBACK');
        cachedPool.client.release();
        cachedPool.client = null;
      } catch (error) {
        console.error('Error rolling back transaction:', error.message);
        if (cachedPool.client) {
          try {
            cachedPool.client.release();
          } catch (releaseError) {
            console.error('Error releasing client after rollback error:', releaseError.message);
          }
          cachedPool.client = null;
        }
        throw error;
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
    console.error("Error in getDBConnection:", error.message);
    if (error.stack) console.error("Stack trace:", error.stack);
    
    // Create minimal failsafe implementation to prevent crashes
    if (!cachedPool) {
      console.log("Creating failsafe DB object to prevent crashes");
      cachedPool = {
        execute: async () => [[], []],
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        connection: { inTransaction: false }
      };
    }
    
    throw error;
  }
};

module.exports = { getDBConnection };
