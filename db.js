const { SecretsManager } = require('aws-sdk');
const mysql = require('mysql2/promise');

const secretsManager = new SecretsManager();

const getDBConfig = async () => {
  const secret = await secretsManager
    .getSecretValue({ SecretId: "my-db-credentials" }) // Replace with your actual secret name
    .promise();
  return JSON.parse(secret.SecretString);
};

const getDBConnection = async () => {
  const dbConfig = await getDBConfig();
  return mysql.createConnection({
    host: dbConfig.host,
    user: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.dbname,
    port: dbConfig.port || 3306,
  });
};

module.exports = { getDBConnection };
