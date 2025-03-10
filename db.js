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
        let result;
        
        // If in a transaction, use the transaction client
        if (cachedPool.client) {
          console.log('Executing query within transaction');
          result = await cachedPool.client.query(text, params);
        } else {
          // Otherwise use the pool
          result = await cachedPool.query(text, params);
        }
        
        return [result.rows, result.fields];
      } catch (error) {
        console.error('SQL Query error:', error.message);
        console.error('Query:', text);
        console.error('Params:', params);
        // Add stack trace for better debugging
        if (error.stack) console.error('Stack trace:', error.stack);
        throw error;
      }
    };
    
    // Add transaction methods to match MySQL interface
    // Using a dedicated client per transaction instead of sharing it
    cachedPool.beginTransaction = async () => {
      try {
        if (cachedPool.client) {
          console.warn('Transaction already in progress, releasing previous client');
          try {
            await cachedPool.client.query('ROLLBACK');
            cachedPool.client.release();
          } catch (err) {
            console.error('Error releasing existing transaction client:', err);
          }
        }
        
        console.log('Beginning new transaction');
        const client = await cachedPool.connect();
        cachedPool.client = client;
        await client.query('BEGIN');
        console.log('Transaction started successfully');
      } catch (error) {
        console.error('Error beginning transaction:', error.message);
        if (error.stack) console.error('Stack:', error.stack);
        throw error;
      }
    };
    
    cachedPool.commit = async () => {
      if (!cachedPool.client) {
        console.warn('Attempted to commit without an active transaction');
        return;
      }
      
      try {
        console.log('Committing transaction');
        await cachedPool.client.query('COMMIT');
        console.log('Transaction committed successfully');
      } catch (error) {
        console.error('Error committing transaction:', error.message);
        if (error.stack) console.error('Stack:', error.stack);
        throw error;
      } finally {
        // Always release the client when done
        if (cachedPool.client) {
          try {
            cachedPool.client.release();
            console.log('Client released after commit');
          } catch (releaseError) {
            console.error('Error releasing client after commit:', releaseError.message);
          }
          cachedPool.client = null;
        }
      }
    };
    
    cachedPool.rollback = async () => {
      if (!cachedPool.client) {
        console.warn('Attempted to rollback without an active transaction');
        return;
      }
      
      try {
        console.log('Rolling back transaction');
        await cachedPool.client.query('ROLLBACK');
        console.log('Transaction rolled back successfully');
      } catch (error) {
        console.error('Error rolling back transaction:', error.message);
        if (error.stack) console.error('Stack:', error.stack);
      } finally {
        // Always release the client when done
        if (cachedPool.client) {
          try {
            cachedPool.client.release();
            console.log('Client released after rollback');
          } catch (releaseError) {
            console.error('Error releasing client after rollback:', releaseError.message);
          }
          cachedPool.client = null;
        }
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
